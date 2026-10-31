# DFIT module in PRiSM (v3.4) — implementation plan

> **Status (2026-10-31):** plan only. No code has been written and no repository file other than this one was changed. The
> module is our own design. No other software product, vendor, company or website is named in it, cited by it or compared
> with it by name; the state of the art is described generically ("commercial DFIT packages commonly …"). Literature is cited
> by author, year, title and SPE number only. An SPE number marked "no. to verify" never goes into the app.

| | |
|---|---|
| Release | **v3.4**, after v3.3 (Build-up Surveillance). Built in two gated increments: **3.4a = app version 3.4** ("DFIT analysis") and **3.4b = app version 3.4.1** ("DFIT in the field") |
| Where | Inside PRiSM, as a fourth **workspace mode** `PRiSM.mode = 'dfit'` (next to transient / decline / combined), registered through a new generic mode-extension registry `window.PRiSM_modeExt`. Header test-type select option "DFIT (fracture injection)". The well's PTA test type stays `falloff` underneath |
| Namespaces | `window.PRiSM_dfit_*` (pure engines and UI entry points, Round 8). `window.WTS_wellbore` (new shared surface ↔ bottomhole engine, Round 9 helper). `window.PRiSM_dfit_synth` (synthetic DFIT generator and benchmark scorer, Round 9 helper). `window.PRiSM_dfit_cal` (generated calibration table, Round 9 data module) |
| New files | Round 8: `56-prism-dfit-core.js`, `57-prism-dfit-aca.js`, `58-prism-dfit-leakoff.js`, `59-prism-dfit-ui.js`. Round 9 helpers (no page): `48-calc-wellbore.js`, `49-calc-dfit-synth.js`, `49-calc-dfit-cal.js` (generated). Tool: `prism-build/dfit-validate.js`. Tests: 18 `tests/dfit-*.test.js` files in 3.4a (≈ 160 tests, ≤ 150 s) and 2 more in 3.4b (≈ 25 tests), plus one helper `tests/_dfit-shapes.js` |
| Edited files (generic hooks only, no DFIT logic) | `01-foundation.js`, `02-plots.js`, `04-ui-wiring.js`, `05-regression.js` (one export), `07-data-enhancements.js`, `11-polish.js`, `33-pta-core.js`, `35-rta-dca.js`, `36-report.js`, `37-prism-workflow.js`, `29-multiwell.js`, `concat-round8.js`, `smoke-test.js`, `gui-sweep.js`; host `well-testing-app.html` (two job-report lines, release notes); `ios-styles.css`; iOS version stamps; README, CLAUDE.md, PROJECT-NOTES |
| File numbers | Round 8 **56–59 only**. 53–55 belong to the Build-up Surveillance plan (`53-prism-autointerp.js`, `54-prism-skin.js`, `55-prism-autointerp-cal.js`); 6N is live data. Anything that does not need the PRiSM shell goes into Round-9 helper modules (the pattern of `40-calc-tubulars.js` and the build-up helpers) |
| Inputs to this plan | The DFIT requirements brief and seven research notes in the session scratchpad folder `shutin/dfit/` (`preclosure.md`, `afterclosure.md`, `leakoff.md`, `related.md`, `landscape.md`, `prism.md`, `ideas-judged.md`) with their verification scripts (`work/`, `_calc/`, `_leakoff/`, `_rel/`, `_ideas/`, `_research/`, `bench/`), CLAUDE.md, and the two earlier plans as models of format. This plan copies everything a builder needs; the notes hold the derivations |

**Conventions.**
- Field units throughout. Engine time is in **hours**; DFIT displays show minutes for the pre-closure period and hours or days after
  closure (display only, never stored). Pressure psia (psi for differences), rate bbl/min in every DFIT-specific object (the PRiSM
  dataset keeps bbl/d), volume bbl, length ft, permeability md, viscosity cp, compressibility 1/psi, E′ in psi (UI in 1e6 psi),
  CL in ft/√min, spurt in gal/100 ft², toughness in psi·√in, temperature °F, gradients psi/ft, density ppg. §3.0 fixes the unit of
  every public field.
- ΔtD = Δt/tp. "G" is the Nolte G-function. "F1/F2/F3" are closure method families (§4.7). "ACA" = after-closure analysis.
- Confidence tags on methods: **[H]** verified by closed form or by our own prototype, **[M]** plausible with stated open items,
  **[L]** indicative only.
- "Desktop" timings come from the research prototypes on the audit server (single thread). "Phone" means × 3.
- Evidence ids look like `C2` (closure family 2) or `A4` (after-closure item 4); §6.10 fixes the groups.

---

## 0. Decisions at a glance

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Where DFIT lives | PRiSM workspace mode `dfit` through a generic `PRiSM_modeExt` registry (§2.1, option B). Not a new test type, not a separate page | A DFIT *is* an injection falloff for every PTA purpose (sign, tp, superposition); a `'dfit'` test type would touch 35 `'falloff'` checks in 14 files. A mode reuses the header, steps, rail, Tools, undo, report tab, plot picker and PDF gallery, all of which are already mode-filtered |
| D2 | Files | Round 8: 56 core (pre-closure), 57 after-closure + results layer, 58 leak-off mini-model + designer, 59 UI. Round-9 helpers: `48-calc-wellbore.js` (`WTS_wellbore`), `49-calc-dfit-synth.js`, `49-calc-dfit-cal.js` | 53–55 are taken by the build-up plan; the wellbore path is a shared engine other pages can reuse |
| D3 | Prerequisite | O(n) sliding-window Bourdet derivative in `02-plots.js` and its four copies (33, 04, 11, 36), with identical output. Plus an O(n) log-from-shut-in resampler in 56 | The current walk-outwards loop is O(n²): C2 takes 849 ms at 2,000 and 3,288 ms at 4,000 evenly sampled falloff points; a two-pointer window computes the same derivative in 0.15 ms (max relative difference 0 on 3,938 points) |
| D4 | Data | The DFIT dataset is the PRiSM dataset (`t` h, `p` psia at the primary gauge, `q` bbl/d) plus optional parallel channels (`pSurf`, `pBh`, `qFb`, `T`, `pAnn`) mapped by new column roles in 07 so they survive a reload. psig is converted with a stated atmospheric pressure (default 14.696 psia). High-rate windows (water hammer, steps) are stored separately, capped | Extra arrays are lost on reload today (07 knows only t/p/q roles); data from the live-data page arrive in psig |
| D5 | C2 use | DFIT writes `testType:'falloff'` and an idealised two-step schedule into `PRiSM.multiRate` on entry (undoable). It builds its own ISIP-referenced and p_i-referenced arrays; C2 is used only for the standard log-log and the PTA hand-off | Auto-detect reads a positive-rate DFIT as a build-up; pump noise with > 20 steps flips C2 to variable-rate; C2 has no reference-pressure option and keeps only Δp > 0 |
| D6 | G-function | Closed forms for α = ½ and α = 1, general α by 64-point Gauss–Legendre, and a data-driven G from the real rate history (or from the mini-model's area history). The G type is printed on every plot. The same α is used for G and for η | Real DFITs have ramps, breakdown surges and two cycles; Gc/(Gc+2) on an α = 1 G is a common pairing error (up to 0.025 in η) |
| D7 | One derivative engine | `PRiSM_compute_bourdet` (after D3) for G·dP/dG (= dP/d ln G), √t·dP/d√t (= 2·dP/d ln Δt) and the log-log derivative | One noise model, one smoothing parameter L, testable identities |
| D8 | ISIP | Four estimates in three families (water-hammer midline, early-G extrapolation, step-down intercept / last pump minus friction), inverse-variance consensus with spread and label; extrapolate on G, never on √t at early time | √t extrapolation over the first minutes reads 22–28 psi high in the reference case |
| D9 | Closure | Every recognised method runs. Methods are grouped into dependence-aware families (F1 first stiffening, F2 end of stiffening, F3 model-based, F0 fissure closure). Stability grid → P10/P50/P90 per family → a single closure or a **closure range**, with a confidence label that lists the rules that fired. Frictional-limit veto. Overrides are logged with a reason. Never a silent single value | The closure dispute (100 to 1,000+ psi between methods) is the main pain point; a √t pick repeats the tangent pick and must not count as confirmation |
| D10 | Downstream consistency | Each closure candidate carries its own consistent chain (Gc, η, pn, χ, CL, geometry, leak-off rate) in a what-if table; every downstream number states which candidate it uses | Swapping only the closure pick into a chain built for another pick is the error the literature warns about |
| D11 | Leak-off type | Rule-based classifier on numeric features (intercept ratio ι, dP/dG trend κ against the *expected* matrix curvature κ_exp, hump H, D/D_ref, closure visibility R_vis, friction bleed-off check) with evidence sentences; dual readings when two classes score within 0.15 (always for height recession vs asperity contact) | No tool classifies with reasons; reservoir-controlled leak-off is routinely mislabelled as PDL or tip extension |
| D12 | After-closure | p_i-free derivative diagnosis (D = t·\|dp/dt\|) as the primary view; centroid time origin t − t_c/3 by default; three p_i brackets intersected; bounds [k_lo, k_hi] with the binding constraint named when radial flow is not reached; impulse → constant-rate transform so any PRiSM model can be matched. No empirical closure-time permeability correlation is shipped | Total time and time-since-closure origins misdiagnose regimes; false radial reads k 100× or more high |
| D13 | Gas | Adjusted pressure and pseudo-time through `PRiSM_mpTable` and `PRiSM_gasPseudoTime`, p_i iterated (≤ 3 passes); forced when (p_c − p_i)/p_i > 0.1 or p_i < 3,000 psia | Pseudo-time stretches the early after-closure clock about 1.5× even at 5,000 psi |
| D14 | Leak-off mini-model | Lumped PKN/KGD/radial fracture, exact Abel bookkeeping of a piecewise-linear area history, two-part leak-off CL = C_w + C_c (wall + reservoir-controlled Duhamel), default w_c = 1 for water-based fluids, semi-implicit step (one bracketed monotone root per step). Apparent toughness labelled "not a rock property" | Reproduces Nolte to 1e-14 (α = 1); one engine from injection through closure into after-closure flow |
| D15 | History match | `PRiSM_lm` with presets, priors and multi-start; the identifiable group Γ = rp·CL/cf is primary; intervals inflated by n_eff and by the spread across closure laws. The fit never goes through `PRiSM_setLastFit` (C4) | A falloff fixes only Γ (E′, hf, CL and toughness correlate at \|r\| ≥ 0.997); perfect-model intervals are 4–14× too narrow |
| D16 | Uncertainty | Seeded Latin hypercube (default n = 1,000) through the closed-form chain; closure resampled from the stability samples so a two-family range stays bimodal; first-order variance shares by quantile binning; tornado; seed stored | No tool propagates picks and inputs to every output |
| D17 | Labels | Rule-based in 3.4a and marked "uncalibrated". 3.4b calibrates them on a 900-case synthetic benchmark (Wilson intervals, out-of-fold) into the generated `49-calc-dfit-cal.js` | The benchmark truth embeds the mini-model's contact physics; we say so next to the label |
| D18 | Live | Replay engine and verdict tile in 3.4a (on recorded data). Live listeners in 3.4b: `wts:modbus-samples` / `wts:historian-updated` on `document`, engines resolved at call time, psig → psia, each block processed by one drive job (no other timer), released on route or mode leave. Never polling | Smoke test fails on pending timers; Round-9/10 engines load after Round 8 |
| D19 | Hand-off | One button per target. PTA: `PRiSM_setWell` (falloff, tShut, tp, pwf0 = ISIP, pi) with source `'dfit'`, the schedule into `multiRate`, model `infiniteFrac`/`finiteFrac`/`homogeneous` seeded with xf and k, `setMode('transient')`, `PRiSM_gotoStep(3)`. RTA: k constraint through a 3-line fallback in 35. Frac design: a ranged sheet (CSV + report section) | Landscape gap: DFIT, PTA and frac design live in separate tools today |
| D20 | Persistence | `st.dfit` (decisions, picks, inputs, small result summaries) in `STATE_FIELDS` → `wts_prism_state`, undoable through a generic `PRiSM_undoExtras` hook; derived arrays recomputed; high-rate windows in `wts_prism_dfit_hf`. DFIT-only inputs (E′, ν, heights, depths, strings, perforations) live in `st.dfit.inputs`, because `PRiSM_setWell` silently drops keys that are not PVT store fields | `16-pvt.js:794` skips unknown keys |
| D21 | Contracts and events | New C1 provenance value `'dfit'` (documented and tested; `setWell` already accepts free text). New events `prism:dfit-updated` and `prism:dfit-model-updated`; generic `prism:plot-hover` | Keeps C4 and the PTA listeners untouched |
| D22 | Report | DFIT report section with plots (new `plots` field in the section contract), mode-aware header and key line, evidence chips, quoted-value check, append-only pick log, data + picks ASCII export, frac-design sheet | Reports and the header Quick Report capture DFIT with no host logic beyond two generic lines |
| D23 | Units | Field units only; PRiSM keeps `#prism_units_note` in Metric mode; DFIT controls are not tagged with `WTS_units.tagInput`; one display ↔ engine conversion table (`PRiSM_dfit_units`) | PRiSM is field-unit only |
| D24 | Standalone leak-off tool | The "what leak-off rate do I get?" sandbox runs inside PRiSM DFIT mode with **no data loaded** (step ④ and a Tools-drawer quick mode). No new sidebar row in v3.4 (Q4) | Production & Reservoir reaches 7 of 8 rows with Build-up Surveillance; the engine is public, so a Round-9 page can follow without new physics |
| D25 | What we never do | No black-box machine-learning closure predictor; no claim of a single "true" closure; lenses labelled by method, never by person or school | Cannot be validated offline; the dispute is open |
| D26 | Budgets | ▶ Analyse ≤ 1.5 s desktop for a 2,000-point falloff (stability grid ≤ 600 ms, chunked); redraw ≤ 30 ms; mini-model ≤ 50 ms at N ≈ 1,840; history match ≤ 1 s; 1,000-draw uncertainty ≤ 60 ms; designer (500 coarse runs) ≤ 1 s chunked | Measured on the prototypes; phones × 3 |
| D27 | Version | 3.4a ships as **v3.4**, 3.4b as **v3.4.1** (`RELEASE_NOTES[0].ver`, MARKETING_VERSION ×2, VERSION_BASE ×2) | Same pattern as 3.2a / 3.2b |

---

## 1. Scope, users and user stories

### 1.1 What the module does

A diagnostic fracture injection test (DFIT, mini-frac, fracture calibration test) pumps a small volume (typically 10–50 bbl)
at a constant rate for a few minutes, breaks the formation down, creates a small fracture and then shuts in for hours to weeks.
The module turns the recorded injection and falloff into:

- **before closure**: ISIP, closure pressure (σ_hmin) as a value or a range with a confidence label, net pressure, fluid
  efficiency, leak-off type, leak-off coefficient (with the group the test actually determines), fracture geometry (PKN, KGD,
  radial) with E′, leak-off rate and cumulative loss;
- **after closure**: flow regime, reservoir pressure with a bracket, transmissibility kh/μ and permeability, or bounds on k when
  radial flow never appears; gas wells in adjusted variables;
- **related tests**: step-down (perforation versus near-wellbore friction, open perforations), step-rate (fracture extension
  pressure, 3.4b), pump-in / flowback (3.4b), water hammer (period, reflector, connection);
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
specialists (stress gradient), injection-well engineers (fracture extension pressure, step-rate tests, 3.4b), reviewers and
regulators (data + picks, evidence trail).

### 1.3 User stories (each is an acceptance item for the named test file)

| # | As a … | I want to … | So that … | Test |
|---|---|---|---|---|
| US1 | stimulation engineer | import a surface-gauge DFIT with rate in bbl/min and get a bottomhole pressure with an uncertainty band and flags for vacuum and column warm-back | I do not analyse a wrong conversion | dfit-wellbore, dfit-integration |
| US2 | any user | see within seconds whether the test is interpretable, which windows are usable and what went wrong | I do not waste a day on a misrun | dfit-triage |
| US3 | stimulation engineer | get ISIP from several independent methods with a spread | net pressure and geometry carry an honest ISIP | dfit-preclosure |
| US4 | stimulation engineer | see every closure method on one strip, a single closure or a range, and why | I can defend the pick | dfit-closure |
| US5 | stimulation engineer | drag a what-if closure along the strip and see η, pn, CL and xf change consistently | I see the consequence of the interpretation choice | dfit-closure, dfit-uncertainty |
| US6 | reservoir engineer | get p_i with a bracket and k (or k bounds) without guessing p_i | I do not report a false radial k | dfit-aca |
| US7 | reservoir engineer | match after-closure data with PRiSM's fractured-well and composite models and hand p_i, k and xf to PTA in one click | DFIT and PTA agree | dfit-aca, dfit-integration |
| US8 | planner | enter ranges before the job and get the shut-in length, volume, gauge spec and expected outcome | the crew knows how long to stay and what they will learn | dfit-designer |
| US9 | anyone | ask "what leak-off rate do I get?" for a planned job with no data | I can size the job and explain leak-off | dfit-leakoff |
| US10 | analyst | history-match the recorded DFIT and be told which parameters it determines | I do not report E′ or CL as if measured | dfit-leakfit |
| US11 | stimulation engineer | split near-wellbore friction into perforation and tortuosity parts with an open-perforation range | I can plan the main treatment | dfit-wellbore |
| US12 | field supervisor (3.4b) | watch the falloff live on a phone with a closure forecast and a stop/continue verdict | I can release the gauge at the right time | dfit-live |
| US13 | team lead | replay a recorded test and see when each conclusion first became available | we can set a shut-in policy from our own history | dfit-live |
| US14 | reviewer / regulator | export data + picks and see every pick, override and reason | the interpretation is reproducible | dfit-report |
| US15 | gas reservoir engineer | analyse after-closure data in adjusted pressure and pseudo-time with p_i iteration | gas k and p_i are not biased | dfit-aca |
| US16 | frac designer | receive closure, ISIP, pn, η, Γ, CL and geometry as P10/P50/P90 with the closure reading (family) named | design inputs carry their uncertainty | dfit-uncertainty, dfit-report |
| US17 | injection engineer (3.4b) | analyse a step-rate test with every sample and get the fracture extension pressure with a band, k and s | the operating limit is objective | dfit-fieldtests |

### 1.4 Parity: what established tools commonly do, and where we cover it

Commercial DFIT capability lives in three generic tool families: fracture-design suites with a minifrac module,
pressure-transient suites with a DFIT analysis type, and newer DFIT-only applications. The rows below are what a user
expects from any of them (landscape matrix "Most"/"Some"). Every row is in 3.4a unless marked.

| Area | What established tools commonly offer | PRiSM DFIT |
|---|---|---|
| Data | Import time / pressure / rate / temperature; manual picks of pump start, breakdown, shut-in; resampling | Same, plus automatic events with refinement, pressure-increment + log-from-shut-in resampler, clock alignment (§4.1, §4.3) |
| Conversion | Surface → bottomhole by a constant gradient; friction table during injection | ρ(p,T) column with temperature models, Newtonian / friction-reduced / power-law friction, perforation and near-wellbore loss, uncertainty band (§4.2) |
| ISIP | Last-point, linear or √t back-extrapolation | Four estimates reconciled; G extrapolation; water-hammer midline (§4.4) |
| Pre-closure plots | G-function (p, dP/dG, G·dP/dG) with α = ½ and α = 1; √t with derivatives; log-log Δp and Bourdet derivative | Same, plus general-α and data-driven G, exact Nolte reference curve on the log-log plot, compliance-versus-pressure plot (§4.5–4.6) |
| Closure | Tangent line, √t inflection, log-log departure; compliance method in newer tools; several picks listed side by side | All of them, plus variable-compliance fit and model closure, grouped in families with a consensus (§4.7, §6.2) |
| Outputs | Net pressure, ISIP and closure gradients, η ≈ Gc/(2 + Gc), CL, PKN/KGD/radial geometry with E′, spurt (frac suites) | Same, with matched-α η, storage-corrected CL, Γ group, automatic geometry selection, spurt only with independent geometry (§4.9–4.10) |
| Leak-off type | Visual overlays: normal, pressure-dependent / fissure opening, tip extension, height recession / transverse storage | Same signatures, classified automatically with evidence (§4.11) |
| After closure | Linear / radial identification on log-log; Nolte F_L / F_R; impulse lines; p_i from p vs t^−½ or t^−1; k from linear (with geometry) and kh/μ from radial; gas pseudo-pressure | All, plus p_i-free diagnosis, bracket, centroid origin, bounds, model-library match (§4.12–4.13) |
| Step tests | Step-down: perforation (∝ q²) vs tortuosity (∝ q^½); step-rate: two-line break | Step-down with identifiability checks and open-perforation range (3.4a); continuous hinge + superposition step-rate (3.4b) (§4.14–4.15) |
| Modelling | Net-pressure history match with a pseudo-3D / planar simulator (frac suites); analytical falloff model across closure (PTA suites) | Lumped leak-off mini-model from injection through closure and after-closure, standalone and history match (§5). No pseudo-3D growth (out of scope) |
| Report | Plots, tables, picks, PDF | Same plus evidence chips, pick log, data + picks export, frac-design sheet (§6.10) |

### 1.5 New features (selected from 44 candidate ideas; scored on value, novelty, soundness, feasibility, testability)

These are the headline capabilities that no surveyed tool documentation describes, or only as written guidance. Scores are out
of 25. Effort is on top of the baseline engines (S ≤ 400 lines, M 400–1,200, L more).

1. **Leak-off sandbox — the requested mini-model** (22, M, 3.4a; §5, §6.1). One engine runs a schedule through propagation,
   shut-in, closure and after-closure flow, and returns the leak-off rate split into wall, reservoir and spurt parts, cumulative
   loss, efficiency, closure time, geometry, the falloff and its own G-plot. It works with no data ("what leak-off rate do I get?",
   "what CL gives my observed closure time?") and as the history-match engine for a recorded test. A stacked bar shows where the
   pumped volume is (fracture / formation / wellbore) over time, and the card always shows the one group a falloff determines.
   *Rationale:* a quick, transparent forward model exists today only inside full fracture-design suites; the owner asked for it;
   and the same engine feeds the designer, the identifiability card, the live forecast and our synthetic test data.
2. **Closure consensus board** (23, M–L, 3.4a; §6.2). Every closure method on one pressure strip, grouped in families with
   P10–P90 bars, giving one closure or a closure range, a confidence label with the rules that fired, "why this pick?" (the plot
   window it used), a frictional-limit veto, the cheapest change that would move the pick, and a logged override. *Rationale:*
   methods differ by 100–1,000+ psi and tools list picks without reconciling them; a range with reasons is more honest and more
   useful than a single number.
3. **Triage and data-health gate** (23, M, 3.4a; §6.3). A traffic-light card within seconds of import (or 30–60 min into a live
   falloff): air or gas in the well, vacuum, thermal transients, leaks, gauge resolution against the derivative signal, volume
   reconciliation, fluid gradient, clock alignment, and the pressure-gradient plot that guidance calls "often missing". It tests
   common unit and depth blunders, gives an early "re-pump?" verdict and a salvage plan. *Rationale:* misruns, wrong units and
   surface-gauge problems are the commonest reasons DFITs fail, and "uninterpretable, but these windows are usable" is a valid
   result no tool returns.
4. **Leak budget and leak plot** (24 — top score, S, 3.4a; §6.4). A permeability-independent leak tolerance for the plan,
   q_k,max = ε·V/(2·t_end), and a p_i-free plot that measures a leak during the falloff and gives a leak-corrected p_i with its
   detection floor. *Rationale:* "small leaks ruin tests" is the most repeated field warning; this turns it into numbers.
5. **Pre-job designer** (22, M, 3.4a; §6.5). Ranges in; out come an expected-outcome label ("closure only" / "linear: p_i ±W" /
   "radial: kh/μ ±x %"), closure time and recommended shut-in at P10/P50/P90, minimum volume, gauge and sample-rate spec, a vacuum
   check, an execution checklist and a P10–P90 pressure corridor. *Rationale:* "how long do we shut in and what will we learn?" is
   asked before every job and today is answered by rule of thumb or a full fracture simulator.
6. **Uncertainty budget and what-if propagator** (22, M, 3.4a; §6.6). P10/P50/P90 on every DFIT number, the share of each spread
   by input, a tornado, and a what-if marker on the closure strip that recomputes everything downstream. *Rationale:* no tool
   propagates picks and inputs; the dispute is argued with differences the size of the interpretation uncertainty.
7. **"What this test can tell you" card** (21, S–M, 3.4a; §6.7). Plain sentences per parameter ("determined ±x", "only as a
   group", "not determined"), a ranking of the next best information, and an extend-the-shut-in table (keep or pull the gauge).
   *Rationale:* stops E′, height and CL being shown as if measured, and answers the daily "keep the gauge?" question with numbers.
8. **After-closure match with the PRiSM model library, and one-click hand-off** (21, M, 3.4a; §6.8). An impulse → constant-rate
   transform lets any PRiSM model fit after-closure data; p_i, k and xf go to PTA, k to RTA, ranged inputs to a frac-design sheet.
   *Rationale:* PRiSM's model library (46 models after v3.3) is an asset no DFIT-only tool has, and the hand-off closes a manual, error-prone step.
9. **Live DFIT co-pilot with replay** (20, M–L; replay and verdict tile 3.4a, live listeners 3.4b; §6.9). Live falloff drawn
   inside the designer corridor, closure provisional → confirmed, a forecast band, the p_i bracket and a verdict tile; replay shows
   when each conclusion first became available on any recorded test. *Rationale:* on-the-fly closure detection and a stop
   criterion are absent from every tool; the app already has a Modbus station, a historian and an offline phone build.
10. **Evidence chips and pick log in the report** (23 for the full idea; S; 3.4a; §6.10). Evidence references on every number, a
   check that quoted values recompute, an undoable append-only pick and override log, and a data + picks export. *Rationale:*
   reproducibility is a recurring complaint and regulators ask for data plus picks.
11. *Stretch (3.4b, first to cut):* **interpretation lenses** (21, S–M; §6.11) — internally consistent calculation chains
   (contact, tangent, global model) side by side with an exact difference breakdown.

**Method upgrades built into the baseline** (not separate features, but each is new against common practice): exact Nolte
reference curve instead of slope guides (the true slope is 0.785 / 0.617 / 0.539 at ΔtD = 1 / 10 / 100); general-α and data-driven
G; matched-α efficiency; storage-corrected CL and the closure-visibility index R_vis; compliance-versus-pressure plot; friction
bleed-off forecast that sets G_min and screens false PDL humps; expected matrix-PDL curvature in the classifier; PDL
quantification (C_d, p_fo, multiplier); height from the recession ratio; closure-time forecast; variable-compliance fit with a CI on
σ_c; the p_i bracket [p − 2D, p − D]; centroid time origin; bound-based ACA; Carter-exact F_R option; identifiability-aware step-down
with an open-perforation P10/P50/P90; the model-derived G that removes the α artefact (a false 15 % early steepening).

**Cut order if 3.4a slips:** lenses (already 3.4b) → drag-to-fit (already 3.4b) → counterfactual line (keep the label and the
why-popover) → next-best-information ranking (keep the identifiability sentences) → replay timeline (keep the verdict tile).

### 1.6 Out of scope for v3.4 (with the reason)

| Item | Why not now | Where it goes |
|---|---|---|
| Doctrine arbitration across closure physics (evidence, model averaging) | Prototype weights collapse to 0/1 on synthetic data; needs tempered likelihoods and the full mechanism set | R2 (after 3.4b) |
| Analysis-by-synthesis leak-off classifier | Needs tip extension and height recession in the fit | R2 |
| Event detective (automatic segmentation, rate recovery from wellbore compressibility) | 3.4a covers clock alignment and basic picks | R2, first in line |
| DFIT gym (teaching mode, quizzes) | Generator ships in 3.4a; the teaching UI is extra | R2 |
| Particle-filter forecast bands, exit alarms, cost-aware stop rule | Builds on the 3.4b live pipeline | R2 |
| Up-down hold-test analyser, blind peer review and sign-off pack | Adoption questions; sign-off shares the build-up helpers later | R2 |
| Compliance sounding with planned micro-pulses (design side) | Needs a field procedure change; 3.4b analyses pulses that exist | R2, experimental |
| Multi-DFIT stress column with depletion and field memory | Needs multi-well results plumbing and n ≥ 4 tests; 3.4a publishes per-well results and comparison rows | R2 |
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
| **B. Workspace mode `PRiSM.mode = 'dfit'`** | Native: same header, step bar, rail slot, Tools, Export, undo/redo, report tab; the plot picker (04:1211) and PDF gallery (11:2983) already filter by `entry.mode`; `setMode` re-renders the shell so `when()` panels re-mount; mode already persists (33:1418); PTA hand-off is `setMode('transient')`; the same hook later serves other special tests (slug/DST, closed chamber) | Small generic edits in 01, 02, 04, 33, 36, 37; transient / decline / combined must stay byte-identical (existing tests cover them) | **Chosen**, implemented as a generic `PRiSM_modeExt` registry so no host file contains DFIT logic |
| C. Tools-drawer workbench | Zero edits | Modal drawer too narrow for linked plots; no step guidance; PTA rail; picks not undoable; poor on phones | Stop-gap only: if WPH slips, 56–58 ship behind a Tools entry and a Tab-2 panel, and move into the mode when the hooks land (engines unchanged) |
| D. Separate Round-9 page | No PRiSM edits | Not "in PRiSM"; duplicates data, plots and regression or reaches across; no shared dataset or well | Only for a later standalone leak-off or step-rate page (Q4, Q5) that calls the Round-8 engines |

### 2.2 Files, rounds and owners

| File | Round | Owner (3.4a) | Contents |
|---|---|---|---|
| `prism-build/56-prism-dfit-core.js` (new) | 8 | WP2 | Pure pre-closure engine: dataset normalisation, units, O(n) resampler, events, G family, derivatives and the Nolte reference curve, ISIP reconciliation, closure methods, variable-compliance fit, consensus and stability, counterfactual, bounds veto, what-if, efficiency, net pressure, compliance, CL, geometry, spurt, PDL, leak-off rate from data, closure forecast, leak-off-type classifier, triage gate and blunder library |
| `prism-build/57-prism-dfit-aca.js` (new) | 8 | WP3 | Pure after-closure and results layer: time functions and centroid, p_i-free diagnosis, brackets, Nolte and impulse lines, bounds, p_i consensus, gas adjustment, impulse → constant-rate transform and model-library match, leak plot, uncertainty propagator, live incremental engine and replay, evidence index, report model, quoted-value check, data + picks export, frac-design sheet, hand-off packets |
| `prism-build/58-prism-dfit-leakoff.js` (new) | 8 | WP4 | Leak-off mini-model (forward, verification modes, quick answers, goal-seek), history match, Fisher / identifiability / value of information, designer ensemble, corridor and checklist, leak budget |
| `prism-build/59-prism-dfit-ui.js` (new) | 8 | WP6 | DOM only: `PRiSM_modeExt.dfit`, step views ② and ④, C7 panels, plot registry entries and plot functions, post-draw hook `dfit-picks`, line tools (merge into `PRiSM_analysisKeys`), rail, ▶ Analyse orchestration with yields and cancel, Tools entries, override dialog, report section rendering, exports, hand-off buttons, live listeners (3.4b), `WTS_state.dfit` |
| `prism-build/48-calc-wellbore.js` (new) | 9, helper | WP1 | `WTS_wellbore`: survey, column ρ(p,T), temperature profiles, pipe friction (Newtonian, friction-reduced, power law), perforation and near-wellbore loss, friction bleed-off, surface ↔ bottomhole conversion with an uncertainty band, vacuum predictor, step-down fit / design check / open perforations, water-hammer quick analysis, clock alignment; 3.4b: two-gauge calibration, Ramey profile, slug tracking, step-rate, flowback and pulses, MOC water-hammer simulator and fit |
| `prism-build/49-calc-dfit-synth.js` (new) | 9, helper | WP5 | `PRiSM_dfit_synth`: seeded case generator (mini-model and analytical sources, artefact injectors), demo datasets, benchmark case list and scorer |
| `prism-build/49-calc-dfit-cal.js` (new, **generated**) | 9, data | WP5 writes the placeholder; WP8 (3.4b) regenerates | `PRiSM_dfit_cal`: label hit rates with Wilson intervals, CUSUM thresholds, generator version |
| `prism-build/dfit-validate.js` (new) | tool | WP5 (tool), WP8 (runs) | Offline benchmark, calibration and `--write` generator for the cal file |
| `prism-build/tests/_dfit-shapes.js` (new) | test helper | WP0 (frozen afterwards) | `checkShape(name, obj)` for every §3 shape, plus fixture objects |

Every Round-9 helper starts with the header line "helper module: does not add a page to window.WTS_calcRegistry", is a single
IIFE, merges into its namespace (`G.WTS_wellbore = G.WTS_wellbore || {}`), and ends with one `// === SELF-TEST ===` block.

### 2.3 Generic edits to existing files (exact; no DFIT logic in any of them)

Line numbers are from the audit at `29c2970`; WPH rebases them on v3.3, which edits 05 and 33 elsewhere (`PRiSM_fitPhysical`,
`PRiSM_physicalModel`).

| File | Edit | Test that proves it |
|---|---|---|
| `02-plots.js` | (a) **O(n) Bourdet**: in `PRiSM_compute_bourdet` (02:1603) precompute `lnx` once and move two monotone pointers (left edge, right edge) instead of walking outwards with `Math.log` at every step; when `lnx` is not monotone, keep the old loop. (b) Window aliases for `PRiSM_plot_finish`, `PRiSM_plot_straightLine`, `PRiSM_plot_keyPoint`, `PRiSM_plot_clip`, `PRiSM_THEME` in the api object (02:2690). (c) `opts.hoverEvent` → dispatch `prism:plot-hover {plotKey, x, y, index}` from the canvas on pointermove (no timer, no throttle object). (d) Pointer-owner hook at the start of the `down` handler (02:1308): `if (canvas._prismPointerOwner && canvas._prismPointerOwner(ev) === true) return;` | `dfit-hooks` H1 (identical output, max relative difference ≤ 1e-12 on log-spaced, uniform and superposition-time sets; 4,000 uniform points < 5 ms), H2, H3; all `wp6-plots` tests unchanged |
| `33-pta-core.js` | Same O(n) window in `_bourdetOnLn` (33:131). `'dfit'` in `STATE_FIELDS` (33:1404) and one restore line (33:1453). Add `prism:dfit-updated`, `prism:dfit-model-updated` and `prism:mode-changed` to the debounced one-shot save list (33:1473–1488) | H1; H6 (reload restores `st.dfit`) |
| `04-ui-wiring.js` | O(n) `_bourdet` (04:433). `_modeAllows` (04:1211): in an ext mode use `ext.showsPlot(entry, key)`, and never show `mode:<ext>` entries in transient or combined. `_normaliseActivePlot` (04:1216) → `ext.defaultPlot`. `_modeShows` (04:1483) → `ext.showsModel`. `modeNote` (04:1962) → `ext.note`. Tab-2 controls: hide the period picker, time-function select and overlay checkbox when `ext.plotsTab.hide` lists them | H5; `wp13-workflow` unchanged |
| `01-foundation.js` | `MODES` = built-ins + keys of `PRiSM_modeExt` (01:695; `state()` 01:735 accepts them). Header select options append `ext.label` (01:871). `onTestType` (01:1375): an ext key → `setMode(key)`. `setMode` (01:1365): calls `prev.onLeave(next)` and `ext.onEnter(prev)` around the re-render. Step labels from `ext.steps` (`markup` 01:859, `compactLabel` 01:1131). `tabForStep` / `showStep` / `gotoStep` (01:725, 1269, 1335) honour `ext.tabs` and `ext.stepView[n]` for **any** n (today only step ② consults `PRiSM_stepViews`). `refreshRail` (01:1233) → `ext.rail(railEl)`. `stepStatus` (01:1078) → `ext.status(snap)`. `analyse` (01:1391) → `ext.analyse(opts)` | H5; `wp13-workflow` unchanged |
| `05-regression.js` | One export: `G.PRiSM_rng = mulberry32` (the seeded generator at 05:812), so DFIT never writes its own PRNG | H8 |
| `07-data-enhancements.js` | Column roles `pressure_surf`, `pressure_ann`, `temp`, `rate_fb` (→ `ds.pSurf`, `ds.pAnn`, `ds.T`, `ds.qFb`) in `ROLES` (07:75) and the header sniffing; liquid-rate units `bbl/min` (factor 1440) and `bbl/h` (24) in 07:108; hints `bpm`, `bbl/min`, `bbl/h` | H9 (a CSV with surface pressure and bbl/min survives a reload with all channels) |
| `11-polish.js` | O(n) `_localBourdet` (11:1570). `_defaultKinds` (11:2349) first reads `PRiSM_PLOT_REGISTRY[plotKey].axes = {x:'lin'\|'log', y:'lin'\|'log'}` | H4 |
| `35-rta-dca.js` | After the last-fit lookup (35:1566): `if (!k && typeof G.PRiSM_dfit_kConstraint === 'function') { var dk = G.PRiSM_dfit_kConstraint(); if (dk && _pos(+dk.k)) { k = +dk.k; kSrc = 'DFIT after-closure'; } }` | H10 |
| `36-report.js` | O(n) `_bourdet` (36:310). Section contract gains `plots:[{key, title}]` (drawn with `PRiSM_renderPlotToCanvas(key)` to PNG) and an optional `fn.modes = [...]` filter; an ext mode with `reportLegacySections:false` skips sections without `modes`. Header and key results come from `ext.reportHeader(model) → {title, keyRows:[[label, text]], keyLine}`; `_plotSpecs(c)` returns `ext.reportPlots` in an ext mode. New exports `G.PRiSM_reportKeyLine()` and `G.PRiSM_reportReady()` (mode-aware) | H7 |
| `37-prism-workflow.js` | `snapObject` / `restoreSnapshot` (37:2362 / 2405) loop over `window.PRiSM_undoExtras` (`{get(), set(v)}` per key). `listTools()` (37:2191) merges `window.PRiSM_toolCatalogueExtra` (entries `{id, fn, group, title, sub, modes}`, filtered by `PRiSM.mode`, de-duplicated by `fn` against discovery) | H6, H11 |
| `29-multiwell.js` | `_extract`: when `st.dfit` has results, add `dfit:{closureGrad, closureLabel, pi, k, kRange}`; `ROWS` += 4 rows with `src:'PRiSM DFIT'` | `dfit-integration` I7 |
| `concat-round8.js` | `FILES` += `56-prism-dfit-core.js`, `57-prism-dfit-aca.js`, `58-prism-dfit-leakoff.js`, `59-prism-dfit-ui.js` after `55-prism-autointerp-cal.js`; banner text | concat runs; harness sees the files |
| `smoke-test.js` | DFIT list (§9, WP6) | itself |
| `gui-sweep.js` | Views for mode `dfit`: steps ①–⑤, step-④ sub-views, every DFIT Tools entry | sweep runs |
| `well-testing-app.html` (host, outside sentinels) | `_rtPrismReady()` (≈ l.3444): `if (typeof window.PRiSM_reportReady === 'function') return window.PRiSM_reportReady();` first. `_rtPrism()` (≈ l.3448): `const _kl = (typeof window.PRiSM_reportKeyLine === 'function') ? window.PRiSM_reportKeyLine() : ''; if (_kl) return { html, key: _kl };` before the PTA key line. `RELEASE_NOTES` (WP7) | `platform-reports` unchanged in transient; I8 in DFIT mode |
| `ios-app/ios-additions/ios-styles.css` | `html.ios-app #prism_dfit_override { padding: max(10px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right)) max(10px, env(safe-area-inset-bottom)) max(10px, env(safe-area-inset-left)); max-height: calc(100dvh - 20px); }` and 44 px min-height for `.prism-dfit-tile button` | `dfit-ui` U12 checks the CSS string |

### 2.4 Load order and feasibility

- **Round 8** runs 33–37, 39, 51, 52, then the build-up files 53–55, then 56 → 57 → 58 → 59. 33 restores `wts_prism_state` at load
  (33:1490), so `st.dfit` exists before 59 reads it. 59 runs after 37 and 11, so it can merge into `PRiSM_analysisKeys`,
  `PRiSM_PLOT_REGISTRY`, `PRiSM_reportSections`, the C7 panel registry, `PRiSM_modeExt`, `PRiSM_undoExtras` and
  `PRiSM_toolCatalogueExtra` at load.
- **Cross-file calls are resolved at call time** (`G.PRiSM_dfit_isip(...)`), never captured at load, inside the Round-8 files as
  well as across rounds.
- **Round 9 after Round 8.** `WTS_wellbore`, `WTS_tubulars`, `WTS_gradient_compute`, `WTS_flowline_friction`, `WTS_gaspvt_*`,
  `WTS_historian`, `PRiSM_dfit_synth` and `PRiSM_dfit_cal` do not exist when Round 8 loads. Every use is behind a `typeof`
  guard with a stated fallback (constant-gradient hydrostatic, Newtonian smooth-pipe friction, "uncalibrated" labels).
  `48-calc-wellbore.js` sorts before `48-calc-wellkill.js` and `49-calc-flowline.js` and therefore also resolves
  `WTS_flowline_friction` at call time.
- **Round 10** (`WTS_modbus`) loads last; the live listeners (3.4b) resolve it per event.
- **Smoke stub.** Every DFIT file loads without `document`, `WTS_units`, `drawLineChart`, the 02 lexical helpers, IndexedDB or the
  Round-9/10 engines. No file starts a timer at load. 59 guards DOM work on `document.getElementById('prism_shell')`.
- **Self-tests.** Each file ends with exactly one `// === SELF-TEST ===` IIFE covering only its own pure functions (stripped by
  concat).

### 2.5 Data flow

```
 CSV / paste / gauge manager (19) / live-data page window / demo (synth) / live samples (3.4b)
        │  07 roles: time, pressure, pressure_surf, rate (bbl/min→bbl/d), rate_fb, temp, pressure_ann
        ▼
 PRiSM_dataset {t h, p psia, q bbl/d, pSurf?, qFb?, T?, meta.dfit}          wts_prism_dfit_hf (high-rate windows)
        │
        ▼  PRiSM_dfit_prepare(ds, inputs, well)                  (56; uses WTS_wellbore.convert when the primary is surface)
 Prepared {t, pw (datum, psia), band, q bbl/min, sigma, quantum, flags}
        │
        ├─► PRiSM_dfit_events ──► Events {tStart, tb, ts (refined), steps, flowback, tp{pump, breakdown, veq}, schedule}
        │        └─► writes PRiSM.multiRate (idealised) + PRiSM_setWell({testType:'falloff', tShut, tp}, {source:'dfit'})
        ├─► PRiSM_dfit_triage ──► Triage {light, checks, windows, blunders, repump}
        ├─► PRiSM_dfit_isip (WTS_wellbore.hammerQuick, .stepDown) ──► IsipResult
        ▼
 PRiSM_dfit_derivs (G family, PRiSM_compute_bourdet) ──► Derivs {G, GdPdG, dPdG, sqrt, D, Dref, mG, gMin}
        ├─► PRiSM_dfit_closurePicks ──► [ClosurePick] ─► PRiSM_dfit_consensus (stability grid) ──► Consensus
        ├─► PRiSM_dfit_classify ──► Classification
        └─► PRiSM_dfit_frac(candidate) / PRiSM_dfit_whatIf(candidates) ──► FracOutputs per candidate
        ▼
 PRiSM_dfit_aca (57) ──► AcaResult {diag, brackets, pi, kh, bounds, match?, gas?}  ─► PRiSM_dfit_leakPlot
        ▼
 PRiSM_dfit_uncertainty (57) ──► Uncertainty {P10/P50/P90 per output, shares, tornado}
        ▼
 PRiSM_dfit_evidence + PRiSM_dfit_reportModel (57) ──► ReportModel ──► 59 renders rail, step views, report section

 Leak-off model (58): PRiSM_dfit_lkSimulate / lkFit / lkFisher  ◄── initial guesses from Consensus, FracOutputs, AcaResult
 Designer (58): PRiSM_dfit_design(ranges) ──► Design {outcome, shut-in, Vmin, gauge, checklist, corridor}
 Live (57 engine, 59 listeners): PRiSM_dfit_live.create(ctx) ◄── samples; replay(ds) ──► timeline
```

### 2.6 How the five-step shell adapts

| Shell item | Transient mode (unchanged) | DFIT mode |
|---|---|---|
| Header select `#prism_testtype` | auto / drawdown / buildup / injection / falloff / rate / combined | + "DFIT (fracture injection)" → `setMode('dfit')` |
| Step labels | ① Data ② Flow periods ③ Diagnose ④ Model & fit ⑤ Report | ① Data & events ② ISIP & friction ③ Pre-closure ④ After-closure & model ⑤ Report |
| Step hosts | tabs 1, step view 2, tab 2, tabs 3–6, tab 7 | ① tab 1 (Data) + DFIT panels; ② step view `PRiSM_dfit_renderStep2`; ③ tab 2 (plots) with DFIT plots + panels; ④ step view `PRiSM_dfit_renderStep4` with its own segmented control (After-closure · Leak-off model · Uncertainty · What this test can tell); ⑤ tab 7 |
| Step ticks (`ext.status`) | data / period / adata.ok / fit converged | ① prepared and triage not red; ② ISIP picked; ③ consensus mode ≠ none (or a user pick); ④ ACA run or "closure only" acknowledged; ⑤ always |
| ▶ Analyse (`ext.analyse`) | data → semilog → race → refine → interp | prepare → events → triage → ISIP → derivatives → closure (+ stability) → classify → frac outputs → ACA → uncertainty → report model; one undo step; yields between stages; Cancel (§4.20) |
| Rail (`ext.rail`) | model, k, S, C, R², pins | ISIP ±; closure value or range + label; closure gradient; pn; η (α); Γ and CL; xf/R; p_i + bracket label; kh/μ or [k_lo, k_hi]; triage light; live verdict (3.4b). `prism-rail--sheet` below 1,024 px as today |
| Tools drawer | catalogue + discovery | + DFIT designer (pre-job), Leak-off sandbox (quick), Replay a recorded DFIT, Water hammer (detail); 3.4b: Live DFIT co-pilot, Step-rate test, Flowback & pulses |
| Undo / redo | well, model, params, fit, period, multiRate | + `PRiSM_undoExtras.dfit` (events, tp and α choices, picks, overrides, options). Restoring marks results stale and runs the fast chain (no stability grid, no uncertainty, ≈ 50 ms) |
| Export menu | report, PDF, CSV, plot PNG, XML | + "DFIT data + picks (ASCII)" and "Frac-design sheet (CSV)" through the same menu (`ext.exportItems`) |
| Units note | `#prism_units_note` in Metric mode | same note; DFIT is field-unit only |

Entering DFIT mode (`ext.onEnter`): record an undo snapshot; `PRiSM_setWell({testType:'falloff'}, {source:'dfit'})` if it is not
already `falloff`; when a dataset exists and `st.dfit.events` is empty, run `PRiSM_dfit_events` and write the idealised schedule to
`PRiSM.multiRate` (`[{t: ts − tp_veq, q: q_eq}, {t: ts, q: 0}]` in bbl/d; C2 negates all-positive steps for injection-like tests,
33:603); go to step ①. Leaving (`ext.onLeave`): nothing is undone (a falloff set-up is right for PTA too); live listeners are
released.

### 2.7 Plots and line tools

- **Registry entries** (merged into `PRiSM_PLOT_REGISTRY`): `{fn, label, mode:'dfit', kind, axes:{x, y}, build(ctx)}`. Each entry
  carries a **real `fn`** (exports at 11:2923 ignore `fnOverride`). The plot list is in §7.9.
- **Plot functions** live at host-IIFE scope in 59 (Round 8 is concatenated inside the host IIFE), built from the lexical 02 helpers
  with `typeof` guards: `PRiSM_plot_dfitDual(canvas, data, opts)` (left pressure axis, right derivative axis, x linear or log,
  overlay lines, bands, markers, shaded windows), `PRiSM_plot_dfitStrip(canvas, data, opts)` (closure strip), and
  `PRiSM_plot_dfitStack(canvas, data, opts)` (stacked volume partition). Log-log plots reuse the `bourdet` drawing style.
  `PRiSM_plot_finish` gives zoom, pan, pinch, persisted user view and `_prismAxes` for free.
- **Picks** are drawn by one post-draw hook `_prismId: 'dfit-picks'`, filtered by `plotKey`, so PDF and PNG exports show them.
- **Linked cursor**: DFIT plots set `opts.hoverEvent`; 59 listens to `prism:plot-hover` and draws the same Δt on the other visible
  DFIT canvases (and the fracture schematic of the sandbox).
- **Line tools** (merged into `PRiSM_analysisKeys`, group "DFIT"): `dfitIsipLine` (2 clicks on `dfitG`: early straight line →
  ISIP_G), `dfitTangent` (1 click on `dfitG`: tangent through the origin touching G·dP/dG near the click), `dfitCompliance` (2
  clicks: early line on G·dP/dG, then the departure), `dfitClosure` (1 click on any pre-closure plot: user closure), `dfitSqrtInfl`
  (1 click on `dfitSqrt`), `dfitAcaLinear` / `dfitAcaRadial` (2 clicks on `dfitFL`/`dfitImpLin` or `dfitFR`/`dfitImpRad`: window),
  `dfitPiLevel` (1 click on `dfitPiTraj`). Every action calls the DFIT engine, stores the result in `st.dfit.picks.user[key]` with
  `source:'user'`, appends to the pick log and fires `prism:dfit-updated {what:'pick'}`.
- **Draggable handles** (pointer-owner hook): the closure marker on `dfitG`, `dfitSqrt` and `dfitLogLog`, the what-if marker on the
  strip, and the ACA window edges. A drag previews with the fast chain; release commits one pick-log entry.

### 2.8 Panels (C7, `when: () => window.PRiSM && PRiSM.mode === 'dfit'`)

| Tab | Panel id | Title | Order |
|---|---|---|---|
| 1 | `dfit-well` | DFIT well, wellbore and fluid | 10 |
| 1 | `dfit-channels` | Channels and bottomhole conversion | 20 |
| 1 | `dfit-triage` | Test triage | 30 |
| 2 | `dfit-board` | Closure consensus | 10 |
| 2 | `dfit-classify` | Leak-off type | 20 |
| 2 | `dfit-frac` | Efficiency, net pressure, CL and geometry | 30 |
| 2 | `dfit-whatif` | What-if closure table | 40 |
| 7 | `dfit-report-opts` | DFIT report options (sections, P10/P90 columns, pick log) | 10 |

The existing Tab-2 `linetools` panel shows the DFIT tool group automatically (it filters by the active plot). Step views ② and ④
render their own cards (they are not tabs).

### 2.9 Persistence, project files, multi-well

- `st.dfit` (§3.3) travels in `wts_prism_state`, in the project `prism` module and in parked multi-well blobs, because `'dfit'` is
  in `STATE_FIELDS`. Only decisions, inputs and small summaries are stored; arrays are recomputed on restore (the fast chain,
  ≈ 50 ms) and the bands on the next ▶ Analyse.
- `wts_prism_dfit_hf`: up to three high-rate windows (§3.11), delta-encoded, ≤ 600 kB. Like every `wts_prism*` key it is carried by
  the project `storage` module and is well-scoped in multi-well projects (29-multiwell takes all project keys that are not
  libraries or preferences).
- No new project module. Raw multi-day 1 s records stay in the gauge manager (19), which already has its own store and project
  path; the analysis dataset is the resampled set.
- `WTS_state.dfit` (published by 59 after each Analyse): `{ok, ts, isip, closure:{mode, value, lo, hi, label}, closureGrad,
  pn, eta, CL, Gamma, xf, pi, piLabel, khmu, k, kLo, kHi, triage, appVersion}`; multi-well comparison rows read it (§2.3).

### 2.10 Report and Quick Report

- One DFIT report section registered in `PRiSM_reportSections` with `fn.modes = ['dfit']` and `plots`. Its content is the
  `ReportModel` of §3.6 (headline table with P10/P50/P90 and evidence column, closure board table, what-if table, ACA table with
  bound directions, leak-off type with evidence, triage table, step-down table, leak-off model summary with Γ, uncertainty shares,
  hand-off values, pick and override log, notes).
- `PRiSM_modeExt.dfit.reportLegacySections = false`, so PTA-only sections (semilog, workspace, gas deliverability) do not print in
  DFIT mode; `ext.reportHeader` gives the DFIT title and key rows; `ext.reportPlots` = `dfitHistory`, `dfitG`, `dfitSqrt`,
  `dfitLogLog`, `dfitStrip`, `dfitAcaLogLog`, `dfitPiTraj` (+ `dfitLkP` when a model fit exists).
- The header Quick Report picks the PRiSM section up through the two host lines of §2.3. Key line example:
  `DFIT · closure 7,000–7,365 psia (range, medium) · p_i 4,500 ±6 psia`.
- Report capture classes: inputs as `.card` / `.fg-item`, results as `.rbox` / `.rrow .rl/.rv`, tables as `table.dtable`, charts as
  `canvas` inside `.chart-wrap`, verdicts as ✓ / ⚠ / ✗ plain text under 300 characters, and a `<div><b>Notes</b> …</div>` box.

### 2.11 Hand-offs to PTA, RTA and other pages

| Target | What moves | How |
|---|---|---|
| PRiSM PTA (transient) | testType falloff, tShut = ts, tp = tp_veq, pwf0 = ISIP, p_i (when its label ≥ medium), idealised schedule; model `infiniteFrac` (ACA linear seen), `finiteFrac` (bilinear seen) or `homogeneous` (radial only); seeds `st.phys.xf` (geometry P50 or ACA L) and k (ACA kh/μ·μ/h) | `PRiSM_dfit_applyHandoff('pta')` after a confirm listing every change: undo snapshot → `PRiSM_setWell(patch, {source:'dfit'})` → `PRiSM.multiRate` → `PRiSM_setModel` → seeds → `setMode('transient')` → `PRiSM_gotoStep(3)`. The DFIT result never goes through `PRiSM_setLastFit`; C3 then floats xf, k, S (optional floatPi) |
| PRiSM RTA (decline mode) | k (P50) and its range | `PRiSM_dfit_kConstraint()` read by the 35 fallback (§2.3); the RTA panel shows "k from DFIT after-closure" |
| Frac design | Closure (value or range, gradient), ISIP, pn, η (upper bound when spurt is unknown), Γ and conditional CL, PDL multiplier, E′ source, geometry, height estimates, lens used; all with P10/P50/P90 | `PRiSM_dfit_fracSheet(state)` → CSV download and report section |
| Well Kill & Bullhead page (fracture gradient) | Closure gradient and ISIP gradient (psi/ft and ppg equivalent) | Published in `WTS_state.dfit`; 3.4 shows a copy-to-clipboard line in the DFIT rail. Reading it from the Well Kill page is an out-of-module follow-up (§9, out-of-module follow-ups) |
| Build-up Surveillance (v3.3) | p_i and k for the same well (injectors: closure as the parting limit) | Published in `WTS_state.dfit`; using it as a reference value on that page is an out-of-module follow-up |
| Multi-well comparison | closure gradient, label, p_i, k | `29-multiwell.js` rows (§2.3) |

### 2.12 Rules for parallel worktrees

1. Each WP works in its own worktree and branch off Dev **after v3.3 is merged and WP0 has landed**.
2. Commit sources only. Never commit a rebuilt `well-testing-app.html`, `ios-app/www/index.html` or any `combined-*.js` from a WP
   branch; tests run with `--sources`. The exceptions are WPH and WP7, which commit hand edits to the host outside the
   injection sentinels on top of Dev's copy.
3. A file belongs to exactly one WP per increment (§2.2, §2.3). A change in another WP's file goes through its owner; the lead
   arbitrates.
4. Code against §3 and the fixtures in `tests/_dfit-shapes.js`, never against another branch. Cross-WP tests live only in
   `dfit-integration.test.js` (WP6), which lands last.
5. The integrator merges in the order of §9.0, then runs concat/inject for Rounds 8 and 9 (and 3+4 when 04/05/07 changed, 1+2
   when 01/02 changed), `sync-from-main`, the smoke test and the touched acceptance files, and commits the rebuilt artefacts on
   Dev. This checkout is LF: skip CLAUDE.md's CRLF step.
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
  | rate (DFIT objects) | **bbl/min** | `q`, `qMax`, `qLast`, `qL` (leak-off rate) |
  | rate (PRiSM dataset only) | bbl/d | `ds.q`, `ds.qFb` |
  | leak rate (leak plot, budget) | bbl/d | `qk`, `qkMax` |
  | volume | bbl | `V`, `Vi`, `ViFrac`, `Vf`, `VL` |
  | storage / system compliance | bbl/psi | `VwCw`, `Csys` |
  | width compliance | ft/psi | `cf` |
  | leak-off coefficient | ft/√min | `CL`, `Cw`, `Cc` |
  | spurt | gal/100 ft² | `Sp` |
  | E′ | psi (UI 1e6 psi) | `Ep` |
  | toughness | psi·√in | `KIc` |
  | viscosity | cp | `mu`, `muRes` |
  | permeability | md; transmissibility kh/μ md·ft/cp | `k`, `khmu` |
  | lengths, depths | ft (TVD unless the name ends in `Md`) | `xf`, `R`, `hf`, `hp`, `datumTvd`, `gaugeMd` |
  | pipe / perforation diameters | in | `id`, `od`, `dIn` |
  | density / gradient | ppg / psi/ft | `rhoPpg`, `gradIsip` |
  | temperature | °F | `T`, `tInjF` |

- **Numbers.** Every output number is finite or `null`; engines convert NaN and Infinity to `null` and add a warning. Masked array
  entries are `null`. Arrays crossing a WP boundary or going to storage are plain arrays; work arrays may be `Float64Array`.
- **Failure.** `{ok:false, code:'<UPPER_SNAKE>', errors:[string], bad:[fieldName]}`. Public functions never throw (they catch and
  convert). Partial success: `ok:true` with `warnings`.
- **Warnings and verdicts.** `{code, level:'info'|'warn'|'bad', text, ev:[evidenceId]}`; `text` is plain, under 299 characters and
  never contains the words "null", "undefined", "NaN" or "Infinity" (GUI-sweep text scan).
- **Purity.** 56, 57, 58 and `WTS_wellbore` touch no DOM, no storage and no timers, and fire no events. Only 59 does. Long work is
  exposed as a **`Job<T>`** (`{step() → {done, progress, label}, result(), cancel()}`, the shape used by the build-up plan) next to a
  synchronous function with the identical result; 59 runs jobs through `PRiSM_autoInterp.drive(job, {shouldCancel, onProgress})`
  (v3.3, the one timer user in Round 8), resolved at call time. Without it, 59 runs the job synchronously.
- **Determinism.** No `Math.random` in any DFIT file (a test greps the sources). Randomness comes only from `PRiSM_rng(seed)`; every
  stochastic result carries its seed. Work slicing is by count, never by elapsed time (wall-clock budgets only stop runaway loops and
  are reported as such).
- **Hashes.** `inputHash` / `resultHash` use `PRiSM_autoInterp.canon` + `hash16` (v3.3, frozen) when present, else `null`.
- **Evidence ids** (§6.10): every result object that produces a reportable number carries `ev:[id]`.

### 3.1 Dataset format (injection + falloff)

DFIT uses the normal PRiSM dataset; nothing outside these fields is required.

```js
PRiSM_dataset = {
  t: [h],                    // monotonic after cleaning; hours since the first sample
  p: [psia],                 // primary pressure channel AS RECORDED at its gauge (bottomhole gauge if present, else surface)
  q: [bbl/d] | null,         // injection rate, POSITIVE while pumping (bbl/min × 1440); null = rate unknown (events from pressure)
  pSurf: [psia] | undefined, // surface (wellhead) pressure when the primary is a bottomhole gauge
  pBh:   [psia] | undefined, // second bottomhole gauge (rare; dual-gauge QA)
  qFb:   [bbl/d] | undefined,// metered flowback rate, POSITIVE out of the well (3.4b analysis; kept from 3.4a)
  T:     [°F]   | undefined, // temperature of the primary gauge
  pAnn:  [psia] | undefined, // annulus pressure (leak / communication check)
  name, source, timeUnit:'h', timeUnitOriginal, rateUnit:'bbl/d', ratePhase:'water',
  meta: { dfit: { primary:'bh'|'surface', psig:{p:false, pSurf:true}, atmPsia:14.696, clockOffsetH:0 } }
}
```

- 07 maps the new roles (`pressure_surf`, `pressure_ann`, `temp`, `rate_fb`) and the units `bbl/min`, `bbl/h`, so a reload
  re-creates every channel from the persisted Data-tab text.
- **psig.** A channel marked psig (by the column mapper's unit, or `meta.unit:'psig'` from the live-data page "Send to PRiSM") is
  converted on preparation with `atmPsia` (default 14.696; 12.2 at 5,000 ft elevation is offered as a hint from the
  well elevation when known). The raw values stay in the dataset; the flag is in `meta.dfit.psig`.
- **High-rate windows** (≥ 2 Hz around shut-in, step changes, flowback start) do not go into the dataset. On import, when the source
  sampling is ≥ 2 Hz, 56 cuts up to three windows (shut-in −10 s … +120 s; the last step-down step; the flowback start) and 59 stores
  them in `wts_prism_dfit_hf` (§3.11).
- **Large records** (> 200,000 rows) are imported through the gauge manager (19); "Use for DFIT" in step ① builds the analysis set
  with `PRiSM_dfit_resample` from `PRiSM_gaugeData.get(id)` arrays (pumping period ≤ 2,000 points, falloff log-spaced from
  shut-in).
- The rate stays positive in the dataset; the falloff sign and the injection-like history come from `testType:'falloff'` and the
  idealised `PRiSM.multiRate` schedule (§2.6).

### 3.2 DFIT inputs (`st.dfit.inputs`, edited in step ①; units per §3.0)

```js
DfitInputs = {
  datumTvd: null,            // REQUIRED for gradients: mid-perforation TVD (ft); null → gradients and conversion disabled with a warning
  datumMd: null,             // null = vertical (MD = TVD)
  survey: null,              // [[md, tvd], …] ascending; linear interpolation
  gauge: { bhTvd: null, bhMd: null },          // primary bottomhole gauge depth (null = gauge at datum)
  strings: [],               // flow path top → perforations: [{tubKey|null, id, od, wall, topMd, botMd}] (WTS_tubulars keys)
  fluid: { kind:'water', rhoPpg:8.43, salinityWt:null, muCp:1.0, fr:0, nPrime:null, kPrime:null, tInjF:70 },
                             // kind 'water'|'slickwater'|'gel'|'oil'; fr = friction reduction 0–0.85 (Virk cap)
  temp: { model:'static', surfF:70, gradFper100:1.5, tauH:[0.5, 5] },   // 'static'|'displaced' (3.4b: 'ramey')
  perfs: { n:null, dIn:0.40, cd:0.62 },      // n = shot holes (null = no open-perforation estimate)
  rock: { Ep:null, EpSource:'unknown', nu:0.25, hf:null, hp:null, barrierSpacing:null, sigmaVGrad:1.0, muFric:0.6 },
                             // EpSource 'static'|'dynamic-corrected'|'dynamic'|'unknown'; heights ft
  priors: { sigmaGrad:null, sigmaGradSd:0.02, piGrad:null },           // psi/ft; used by forecast, designer, blunder scoring
  options: {
    alpha:'auto',            // 'auto'|0.5|1|'general'|'data' ('auto' = data-driven when rate history exists, else 0.5)
    tp:'pump',               // 'pump'|'breakdown'|'veq' (pump start / breakdown / Vi ÷ q_last)
    L:0.1,                   // Bourdet window, ln units (0.05–0.4)
    gMin:'auto',             // 'auto' | number (G units)
    eps:{ compliance:0.02, tangent:0.02, loglog:0.05 },
    aca:{ origin:'centroid', LB:0.25, carterExactFR:false, tideRemove:'auto' },
    unc:{ n:1000, seed:1 },
    atmPsia:14.696
  }
}
```

Reservoir and fluid properties (`pi`, `phi`, `ct`, `mu`, `h`, `T_F`, `fluid`, `SG_g`) are **not** copied here: engines receive
`well = PRiSM_getWell()` (C1) and the DFIT cards edit them through `PRiSM_setWell(patch, {source:'user'})`. DFIT writes
C1 only with `{source:'dfit'}` for `testType`, `tShut`, `tp`, `pwf0` and (on hand-off) `pi`. `muRes` is always the reservoir-fluid
viscosity from C1; the injectate viscosity is `fluid.muCp`.

### 3.3 State (`st.dfit` in `wts_prism_state`)

```js
st.dfit = {
  v: 1,
  inputs: DfitInputs,
  events: Events | null,                        // §3.5; source 'auto' | 'user' per field
  picks: {
    isip:    { value, method, source:'auto'|'user', at } | null,
    closure: { mode:'consensus'|'user', method, p, dt, source, reason, at } | null,   // the chosen value (§6.2)
    whatIf:  { p } | null,                       // transient what-if marker (not persisted across reload)
    user:    { [toolKey]: { G, dt, p, value, at } },     // line-tool results
    aca:     { origin, linWin:[t0,t1]|null, radWin:[t0,t1]|null, piLevel:null }
  },
  summary: {                                     // small cached result summaries for the rail, report and Quick Report
    at, inputHash, resultHash, stale:false,
    isip:{value, spread, label}, closure:{mode, value, lo, hi, label}, pn, eta, CL, Gamma, xf, R, model,
    pi:{value, lo, hi, label}, khmu, k, kLo, kHi, triage:'green'|'amber'|'red', unc:{seed, n}
  } | null,
  lk:   { cfg, preset, fit:{params, ci95, ci95Inflated, groups, chi2, at} | null, gridN } | null,     // leak-off model
  plan: { ranges, summary, corridor:{t:[], p10:[], p50:[], p90:[]} } | null,                     // designer (≤ 60 points)
  live: { tags:{p, pSurf, q, T}, enabled:false, verdictLog:[{t, verdict, text}] } | null,        // 3.4b; no buffers stored
  log:  [ { seq, at, who, item, old, new, reason } ]            // append-only pick/override log, cap 300 (older condensed)
}
```

Derived arrays (prepared series, derivatives, picks with bands, ACA arrays, samples) are **never** stored; they are rebuilt from
the dataset and `st.dfit` on restore. `who` is the free-text analyst name from the report options (default empty).

### 3.4 `WTS_wellbore` (48-calc-wellbore.js, WP1; 3.4b items marked)

| Function | Input | Output |
|---|---|---|
| `column(spec)` | `{survey, strings, fluid, temp, datumTvd, datumMd}` | `Column {ok, tvdAt(md), mdAt(tvd), capacityAt(md) bbl/ft, segments:[{topMd, botMd, id, od, wall, area}], warnings}` |
| `tempProfile(column, opts)` | `{model:'static'\|'displaced'\|'ramey'*, t, Vinj, q, tauH}` | `{ok, T(tvd) → °F, model}` (* 3.4b) |
| `hydrostatic(pKnown, tvdKnown, tvdTarget, column, T)` | | `{ok, p, rhoBar (ppg), dp, rangeNote}` (ρ(p,T) RK2 at 10 ft; ρ_sc(S)/B_w via `PRiSM_pvt_correlations.Bw_meehan`; gas sections through `WTS_gradient_compute`) |
| `pipeFriction(q, seg, fluid, T)` | q bbl/min | `{ok, dpdl psi/ft, v ft/s, re, regime:'laminar'\|'turbulent', f (Fanning), model:'newtonian'\|'fr'\|'powerlaw'}` |
| `perfFriction(q, perfs, rhoPpg)` | | psi: 0.2369·q²·ρ/(n²·d⁴·Cd²) |
| `nwbLoss(q, {b, beta, qt})` | | psi: two-branch law (§4.2) |
| `bleedOff({b, beta, qt, VwCw, d0})` | | `{t1psi h, t10psi h, curve(dt) → psi}` |
| `convert(ds, prepCtx, opts)` | `opts {band:true}` | `{ok, pw:[], parts:{hyd:[], pipe:[], perf:[], nwb:[]}, band:{p10:[], p90:[]}\|null, terms:[{name, dpAtShutIn}], flags:[Warning], vacuumAt:h\|null}` |
| `vacuum(piPsia, column, T, atm)` | | `{risk:'none'\|'surface-zero', pSurfAtPi, text}` |
| `stepDown(steps, opts)` | `steps [{q, p, n, t}]`, `opts {beta:0.5\|'free', drift:true, pipe:fn\|null, perfs, rhoPpg}` | `StepDown {ok, pFrac, se:{pFrac, a, b}, a, b, beta, drift, nOpen, nOpenBand:{p10,p50,p90, driver}, at:{dpPerf, dpNwb, dpPipe}, label, refused:null\|string, resid, corr}` |
| `stepDownDesignCheck(steps)` | | `{ok, se:{pFrac, a, b}, why}` (refuses a split when the rate range < 30 % or < 3 steps) |
| `hammerQuick(tHz, p, ts, ctx)` | high-rate window, `ctx {column, fluid, qShut, tClose}` | `Hammer {ok, why, c, cSource:'korteweg'\|'calibrated', T, tau, delta, A, phi, isip, regime:'ringing'\|'staircase'\|'single'\|'none', Lquarter, Lhalf, reflectorMatch:'perfs'\|'shallower'\|'deeper'\|'unknown', gammaDecay, joukowsky:{expected, measured, ratio}, tEnd h, sampling:{hz, perPeriod, ok}}` |
| `align(tp, p, tq, q, opts)` | two clocks | `{offsetS, driftSPerDay, score, events:[], hourShift:bool, method:'xcorr'\|'event'}` |
| `calibrateTwoGauge(...)` * | | `{FR, rhoEff, tauH, kPrime\|null, resid}` (3.4b) |
| `stepRate(t, p, q, opts)` * | | `StepRate` (§4.15; 3.4b) |
| `flowback(t, p, qFb, ctx)` *, `pulses(...)` * | | `Flowback`, `[Pulse]` (§4.16; 3.4b) |
| `mocSim(params)` *, `hammerFit(...)` * | | MOC traces and fit (§4.17; 3.4b) |
| `injector(ctx)` * | | `{regime:'matrix'\|'fractured'\|'thermal'\|'undetermined', evidence, hall, masip(q)}` (3.4b) |

### 3.5 `56-prism-dfit-core.js` (WP2)

| Function | Input | Output |
|---|---|---|
| `PRiSM_dfit_units` | — | `{toEngine(obj), toDisplay(obj), table}` (bbl/min ↔ ft³/h 336.875, ft/√min ↔ ft/√h 7.74597, gal/100 ft² ↔ ft 1/748.05, psi·√in ↔ psi·√ft 0.288675, cp ↔ psi·h 4.02883e-11, md ↔ ft² 1.062315e-14) |
| `PRiSM_dfit_prepare(ds, inputs, well)` | | `Prepared {ok, t:[], pw:[], band:{p10:[],p90:[]}\|null, pSurf:[]\|null, q:[] (bbl/min), T:[]\|null, src:'bh'\|'surface-converted', sigma, quantum, flags:[], hf:{windows}\|null}` |
| `PRiSM_dfit_resample(t, p, ts, opts)` | `opts {perDecade:40, dpMin, keepPump:2000}` | `{idx:[], t:[], p:[]}` — O(n), log-spaced from shut-in plus a pressure-increment rule |
| `PRiSM_dfit_events(prep, opts)` | `opts {qStartFrac:0.02, qStopFrac:0.05}` | `Events` (below) |
| `PRiSM_dfit_g(dtD, alpha)`, `PRiSM_dfit_gPrime(dtD, alpha)`, `PRiSM_dfit_G(dtD, alpha \| gSpec)`, `PRiSM_dfit_Ginv(G, alpha \| gSpec)` | `alpha` 0.5, 1 or any value in (0.5, 1]; `gSpec` from `gFromHistory` | numbers (closed forms, 64-point Gauss–Legendre, data-driven) |
| `PRiSM_dfit_gFromHistory(schedule, ts, tp, opts)` | `opts {alpha, area:'volume'\|'model', modelHist}` | `gSpec {kind:'data'\|'model', g0, G(dt), Gp(dt), tauNodes}` |
| `PRiSM_dfit_derivs(prep, events, opts)` | `opts {alpha, tp, L, gMin, isip}` | `Derivs` (below) |
| `PRiSM_dfit_isip(prep, events, derivs, ctx)` | `ctx {hammer, stepDown}` | `IsipResult` |
| `PRiSM_dfit_closurePicks(derivs, ctx)` | | `[ClosurePick]` |
| `PRiSM_dfit_varComplianceFit(derivs, ctx, opts)` | | `{ok, sigmaC, ci95, sc, fres, K, isip, corrSigmaSc, resid, rmse}` |
| `PRiSM_dfit_vcModel(G, params, ctx)` | `params {isip, K, sigmaC, sc, fres, Cd, pfo, pr, VwCw, tipA, hrStep}` | `p[]` on the G grid — the G-domain forward model of the fit, also used by tests to build normal, matrix, PDL, contact, height-recession, tip-extension and storage signatures |
| `PRiSM_dfit_consensus(picks, derivs, ctx)` / `PRiSM_dfit_consensusJob(...)` | | `Consensus` / `Job<Consensus>` (stability grid) |
| `PRiSM_dfit_counterfactual(consensus, derivs, ctx)` | | `{knob, change, text, ev}` or `null` |
| `PRiSM_dfit_bounds(candidate, ctx)` | | `{admissible:bool, vetoes:[{rule, text, value, limit}]}` |
| `PRiSM_dfit_classify(derivs, ctx)` | | `Classification` |
| `PRiSM_dfit_frac(pClosure, derivs, ctx)` | | `FracOutputs` |
| `PRiSM_dfit_whatIf(candidates, derivs, ctx)` | `candidates [{label, p, method}]` | `[FracOutputs + {label}]` |
| `PRiSM_dfit_leakoffRate(derivs, frac)` | | `{dt:[], qL:[], VL:[], Vf:[]}` (from the data, §4.10) |
| `PRiSM_dfit_forecastClosure(derivs, ctx, sigmas)` | | `[{sigma, Gc, dtc}]` |
| `PRiSM_dfit_triage(prep, events, ctx)` | | `Triage` |
| `PRiSM_dfit_fastChain(state)` | | `{prep, events, derivs, isip, picks, consensusLite, frac}` without stability grid (undo, drag preview, live) |

```js
Events = { ok, tStart, tb, pb, ts, tsRefined:true|false, tEnd, qMax, qLast, Vi, ViFrac, VwCwMeasured,
           tp:{pump, breakdown, veq}, rampDownFrac,
           steps:[{t0, t1, q, pSettled, n}],           // step-down / step-rate steps (bbl/min, psia)
           flowback:{t0, t1, q, V}|null, cycles:[{tStart, ts, Vi, closedBefore:bool}],
           schedule:[{t, q}],                          // idealised (bbl/min); written to PRiSM.multiRate as bbl/d
           source:{tStart:'auto'|'user', tb:…, ts:…}, warnings:[], ev:['E1'] }

Derivs = { ok, alpha, gType:'a05'|'a1'|'general'|'data', tp, tpChoice, dt:[], dtD:[], G:[], p:[], dpIsip:[],
           GdPdG:[], dPdG:[], sqrtDt:[], sdPds:[], dPds:[], D:[], Dref:[], mG, earlyWin:[G0, G1],
           L, gMin, gMinWhy:'hammer'|'bleed-off'|'thermal'|'1%'|'user', usable:[0|1], sigmaY, ev:['G1'] }

IsipResult = { ok, value, spread, confidence:'high'|'medium'|'low', why:[string],
               candidates:[{method:'wh'|'g'|'sd'|'lp', family:'wave'|'falloff'|'friction', value, se, ok, why, ev}],
               loglogCheck:{isipBest, ok}, ev:['I1'] }

ClosurePick = { method:'tangent'|'sqrt'|'maxdpdg'|'compliance'|'crel'|'loglog'|'varcomp'|'model'|'fissure'|'user',
                family:'F0'|'F1'|'F2'|'F3', ok, dt, G, p, band:{p10, p50, p90}|null, se, window:[G0, G1],
                admissible:true, vetoes:[], sameEvidenceAs:null|method, evidence:[{text, ev}], ev }

Consensus = { ok, mode:'single'|'range'|'none',
              value, range:[lo, hi]|null, families:{F1:{p10,p50,p90,n}|null, F2:{…}|null, F3:{…}|null, F0:{…}|null},
              preferred:'F1'|'F2'|null, preferredWhy, confidence:'high'|'medium'|'low'|'not-estimable',
              calibrated:false, hitRate:{p, lo, hi, n}|null, rules:[{id, fired, value, threshold, text}],
              stability:{L:[0.05,0.1,0.2], tp:['pump','breakdown','veq'], grid:{F1:[[p]], F2:[[p]]}, unstable:bool},
              samples:{F1:[p], F2:[p]},          // kept in memory for the uncertainty propagator, never stored
              counterfactual:{knob, change, text}|null, forecast:[{sigma, Gc, dtc}]|null, ev:['C1','K1'] }

Classification = { ok, type:'normal'|'matrix'|'pdl'|'tip'|'hr-contact'|'storage'|'undetermined',
                   scores:{normal, matrix, pdl, tip, hrContact, storage}, alt:[type],
                   features:{iota, kappa, kappaExp, H, DoverDref, Rvis, bleedOffExplained:bool},
                   pdl:{pfo, Cd, multAtIsip, sigmaHminusH}|null, hr:{Rs, hf0FromPKN, hf0FromKGD}|null,
                   evidence:[string], ev:['M1'] }

FracOutputs = { pClosure, method, Gc, dtc, dtDc, eta:{a05, a1, matched, alphaUsed}, pn, chi, gradIsip, gradClosure,
                Csys, Rvis, Gamma, mG, geometry:{model:'PKN'|'KGD'|'radial', auto:true, consistent:bool, msgs:[],
                byModel:{PKN:{cf, L, Af, rp, CL, CLcorr, wAvg, wMax, Vf, VLpump}, KGD:{…}, radial:{…}}},
                spurt:{value|null, note}, kLeakoff, pdlMult|null, ev:['F1'] }

Triage = { ok, light:'green'|'amber'|'red', verdict:'interpretable'|'partly'|'uninterpretable',
           checks:[{id, title, level:'pass'|'warn'|'fail'|'na', value, threshold, text, ev}],
           windows:{usable:[[t0, t1]], excluded:[{t0, t1, why}]},
           blunders:[{id, hypothesis, bf, fix:{field, from, to}, text}],
           repump:{verdict:'continue'|'caution'|'repump', rules:[{id, level, text}], ack:false},
           salvage:[string], ev:['Q1'] }
```

### 3.6 `57-prism-dfit-aca.js` (WP3)

| Function | Input | Output |
|---|---|---|
| `PRiSM_dfit_timeFns(tInj, tcInj, opts)` | `opts {carterExact:false, ta:[]\|null}` | `{FL:[], FR:[], FRc:[]}` |
| `PRiSM_dfit_centroid(src)` | `{tcInj}` or `{tau:[], qL:[]}` | h (t_c/3 for Carter) |
| `PRiSM_dfit_genTimeFn(tInj, src, n)` | | `F_n[]` (3.4b) |
| `PRiSM_dfit_acaDiag(t, p, opts)` | `opts {t0, LB, sigma}` | `{x:[], D:[], sD:[], n:[], piLo:[], piHi:[], piPoint:[], noiseD:[], regimes:[{kind, t0, t1, slope}]}` |
| `PRiSM_dfit_nolte(ctx)` | `{tInj, p, tcInj, V, linWin, radWin, CL, mu, phi, ct, h}` | `{lin:{pr, mL, k, win}\|null, rad:{pr, mR, khmu, k, win}\|null}` |
| `PRiSM_dfit_impulseLines(ctx)` | `{t, p, t0, V, win, regime, A, h, mu, phi, ct}` | `{pi, m, group:'Ask'\|'khmu'\|'ks'\|'kfw', value}` |
| `PRiSM_dfit_acaBounds(ctx)` | `{diag, Lmax, Amax, CL, CLlo, pFracBar, piLo, tEnd, t0, ranges}` | `{kLo, kHi, binding:[{edge, rule, value}], direction:'normal'\|'reversed'}` |
| `PRiSM_dfit_piConsensus(ctx)` | candidates + brackets | `{value, lo, hi, label:'high'\|'medium'\|'low', reasons:[], edges:{lo, hi}}` |
| `PRiSM_dfit_gasAdjust(t, p, ctx)` | `{pi, T_F, SG_g, ct}` | `{ok, pa:[], ta:[], iterations, converged}` via `PRiSM_mpTable` / `PRiSM_gasPseudoTime` |
| `PRiSM_dfit_crTransform(t, p, ctx)` | `{t0, V, pi\|null}` | `{t:[], y:[] (psi per STB/d), yPiFree:[]}` |
| `PRiSM_dfit_acaMatch(ctx, opts)` / `…Job` | `opts {models:['infiniteFrac','finiteFrac','homogeneous','radialComposite'], piBracket}` | `{ok, best:{model, k, L, pi, ci95, bic, params}, candidates:[…]}` |
| `PRiSM_dfit_aca(state, opts)` | | `AcaResult` (below) |
| `PRiSM_dfit_leakPlot(aca, ctx)` | | `LeakPlot {ok, form:'linear'\|'radial', A, B, qk, qkCI:[lo,hi], floor, piCorr, piUncorr, windowBiasNote, qkMax, verdict}` |
| `PRiSM_dfit_uncertainty(state, opts)` / `…Job` | `opts {n, seed, correlations, mode:'chain'}` | `Uncertainty` (below) |
| `PRiSM_dfit_live.create(ctx)` | `ctx {state, plan\|null, dpMin, cusum:{k:0.5, h:5}}` | `LiveSession {push(samples[{t, p, q?, T?}]) → {changed}, state(), verdict(), timeline(), close()}` |
| `PRiSM_dfit_replay(ds, ctx)` / `…Job` | | `{timeline:[{t, verdict, text}], firsts:{closureProvisional, closureConfirmed, piW25, piW10, radialSeen}, tEnd}` |
| `PRiSM_dfit_evidence(state)` | | `EvidenceIndex {items:{[id]: {id, group, title, values, text}}, order:[]}` |
| `PRiSM_dfit_reportModel(state)` | | `ReportModel` (same block kinds as the build-up plan: verdict, kv, kpi, table, notes, chart) |
| `PRiSM_dfit_checkQuoted(model, state)` | | `{ok, nChecked, nFailed, failures:[{ref, quoted, recomputed}]}` |
| `PRiSM_dfit_exportText(state)` | | `{text, filename:'dfit-<name>-<hash8>.txt'}` (§6.10) |
| `PRiSM_dfit_fracSheet(state)` | | `{rows:[[name, p10, p50, p90, unit, lens, ev]], csv}` |
| `PRiSM_dfit_handoff(state, target)` | `'pta'\|'rta'\|'frac'` | `HandoffPacket {target, setWell:{…}, multiRate:[…], model, seeds:{xf, k, pi}, notes:[], blockers:[]}` |
| `PRiSM_dfit_kConstraint()` | — | `{k, kLo, kHi, source:'aca-radial'\|'aca-match'\|'bounds'}` or `null` (reads `st.dfit.summary`) |

```js
AcaResult = { ok, regimeSummary:'none'|'linear'|'linear-radial'|'radial'|'spherical'|'storage',
              origin, t0, tcInj, V, diag, nolte, impulse:{lin, rad, sph},
              brackets:{cart:[lo,hi]|null, imp:[lo,hi]|null, deriv:[lo,hi]|null, combined:[lo,hi]|null, edges:{lo, hi}},
              pi:{value, lo, hi, label, reasons}, kh:{khmu, k, biasDirection:'upper'|'none'}|null,
              bounds:{kLo, kHi, binding, direction}|null, match:{…}|null, gas:{iterations, converged}|null,
              eps:{atClosure, now}, ratios:{AacaOverAcarter, lambda}|null, warnings:[], ev:['A1'] }

Uncertainty = { ok, n, seed, inputs:[{name, dist, params, provenance}],
                outputs:{ [name]: {p10, p50, p90, unit, shares:[{input, s}], closureShare, bimodal:bool} },
                tornado:[{output, input, lo, hi}], ev:['U1'] }
```

### 3.7 `58-prism-dfit-leakoff.js` (WP4)

| Function | Input | Output |
|---|---|---|
| `PRiSM_dfit_lkDefaults()` | — | `LkConfig` in display units (the §5.4 base case) |
| `PRiSM_dfit_lkToEngine(cfg)` | `LkConfig` | engine config (consistent units h, ft, psi, ft³, psi·h; derived κ, rp(L), C_c ↔ k) |
| `PRiSM_dfit_lkSimulate(cfg, opts)` | `opts {grid:'fit'\|'display'\|'coarse'\|{dt0, r, nShut}, budgetMs:2000}` | `LkResult` (below) |
| `PRiSM_dfit_lkSample(res, t)` | | p_w at data times (linear in t) |
| `PRiSM_dfit_lkQuick(cfg)` | | `{rows:[{label, dtMin, qL}], VL, eta, tc, xf, wAvg, partition:{frac, form, wb}}` |
| `PRiSM_dfit_lkSolveCL(cfg, dtcObserved)` | h | `{ok, CL, runs}` (bisection on log CL, ≈ 25 runs) |
| `PRiSM_dfit_lkGoalSeek(cfg, goal)` | `{kind:'visibleClosureBy', tH}` | `{ok, V, q, table:[…]}` (V × q grid scan, coarse grid) |
| `PRiSM_dfit_lkFit(data, cfg, preset, opts)` / `…Job` | `data {t, p, w?}`, preset `'falloff'\|'full'\|'geometry'\|'pdl'\|'spurt'` | `LkFit` (below) |
| `PRiSM_dfit_lkFisher(cfg, design)` | `{tEnd, sigma, nPts, free}` | `{ci, corr, eig, sloppy:[{vec, text}]}` |
| `PRiSM_dfit_lkGroups(cfg)` | | `{Gamma, mG, text}` |
| `PRiSM_dfit_identify(fit, ctx)` | | `Identify {rows:[{param, status:'determined'\|'group'\|'not', pm, text}], sloppyText, voi:[{source, reduction, text}], extend:[{tEndD, sdPi, kRange, pRadial}]}` |
| `PRiSM_dfit_lkVerify()` | — | V1–V5 numbers (tests and a hidden self-check button) |
| `PRiSM_dfit_design(ranges, opts)` / `…Job` | `DesignRanges`, `opts {n:500, seed, grid:'coarse'}` | `Design` (below) |
| `PRiSM_dfit_leakBudget(V, tEnd, ctx)` | | `{qkMax, holdMin, text}` |

```js
LkConfig = { mode:'propagate'|'prescribed'|'constP', geometry:'PKN'|'KGD'|'radial',
             schedule:[{t, q}],                       // bbl/min steps (from Events or typed)
             Ep, nu, hf, hp, muCp, KIc:14000, viscCal:1, CL, wc:1, Sp:0, pdl:{Cd:0, pfo:null, fmax:50},
             sigmaC, pr, VwCw, nwb:{a, b, beta:0.5}|null, pBd:null, L0:1,
             aperture:{law:'none'|'exp'|'hyp', sh:60, sc:100, fres:0.1}, tip:{tauX:null}, farField:false,
             tEnd, k:null, phi, ct, muRes }       // k and C_c are one parameter when wc > 0

LkResult = { ok, why, t:[], pw:[], pf:[], L:[], A:[], AL:[], W:[], Vf:[], Vi:[], VL:[], VLw:[], VLc:[], VS:[], qL:[], eta:[],
             Ggen:[], events:{tb, pb, ts, isip, tcMech, tcHyd, Gc:{a05, a1, gen}}, xf:{ts, tc},
             kEquiv, tDxfMax, balanceErr, regime:{tipShare}, validity:[Warning], warnings:[] }

LkFit = { ok, preset, params, ci95, ci95Inflated, corr, nEff, rho1, structural:{sigmaC:[lo,hi], pr:[lo,hi], CL:[lo,hi]},
          groups:{Gamma, text}, sloppy:[{vec, text}], starts:{n, converged}, runs, ms, chi2, rmse, stopReason, warnings }

Design = { ok, n, seed, outcome:{label:'closure-only'|'linear'|'radial', text},
           tc:{p10,p50,p90}, shutIn:{p10,p50,p90, binding:'radial'|'3tc'|'afterflow'|'precision'},
           tRadial:{p10,p50,p90}, signalPsi:{p10,p50,p90}, Vmin, Rvis:{p50}, vacuum:{risk, text},
           gauge:{bhRequired, why:[], hz, resolutionPsi, driftPsiPerDay}, leak:{qkMax, holdMin},
           stepDown:{rates:[]}, precision:[{tEndD, sdPi}], checklist:[{id, text}],
           corridor:{t:[], p10:[], p50:[], p90:[]}, warnings }
```

### 3.8 `59-prism-dfit-ui.js` (WP6)

| Export | Purpose |
|---|---|
| `PRiSM_modeExt.dfit` | `{label, testType:'falloff', steps, tabs:{1:1, 3:2, 5:7}, stepView:{2: PRiSM_dfit_renderStep2, 4: PRiSM_dfit_renderStep4}, defaultPlot:'dfitG', showsPlot, showsModel:() => false, plotsTab:{hide:['period','timeFn','overlay']}, note, rail, status, analyse, onEnter, onLeave, reportHeader, reportPlots, reportLegacySections:false, exportItems}` |
| `PRiSM_dfit_analyse(opts)` | ▶ Analyse in DFIT mode → `Promise` (stages of §4.20; one undo step) |
| `PRiSM_dfit_renderStep2(host)`, `PRiSM_dfit_renderStep4(host)` | step views |
| `PRiSM_renderDfitDesignerTool(host)`, `PRiSM_renderDfitSandboxTool(host)`, `PRiSM_renderDfitReplayTool(host)`, `PRiSM_renderDfitHammerTool(host)`; 3.4b `PRiSM_renderDfitLiveTool`, `PRiSM_renderDfitStepRateTool`, `PRiSM_renderDfitFlowbackTool` | Tools drawer (registered in `PRiSM_toolCatalogueExtra` with `modes:['dfit']`) |
| `PRiSM_dfit_state()` | returns `st.dfit` (creates the default object) |
| `PRiSM_dfit_setPick(item, value, {source, reason})` | the only writer of picks: records an undo snapshot, appends to the log, recomputes the fast chain, fires `prism:dfit-updated {what:'pick', item}` |
| `PRiSM_dfit_applyHandoff(target)` | confirm dialog → apply `PRiSM_dfit_handoff` |
| `PRiSM_dfit_results()` | `st.dfit.summary` for the rail, report key line, `WTS_state.dfit` |
| `PRiSM_plot_dfitDual`, `PRiSM_plot_dfitStrip`, `PRiSM_plot_dfitStack` | plot functions (host-IIFE scope, bridged to window) |

### 3.9 `PRiSM_dfit_synth` and `PRiSM_dfit_cal` (Round-9 helpers, WP5)

```js
PRiSM_dfit_synth = {
  version: 'g1',
  make(caseSpec, seed) → { ds, truth, artefacts, caseSpec },     // ds in §3.1 format
  demo(name) → ds,                                               // 'reference' | 'tight-linear' | 'conventional-radial' | 'contact' | 'pdl' | 'surface-gauge'
  cases(kind) → [CaseSpec],                                      // 'acceptance' (12) | 'benchmark' (900) | 'artefact' (60)
  score(result, truth) → { closure:{right, err, inBand}, classify:{right, partial}, pi:{right, err}, k:{right}, labels }
}
CaseSpec = { id, source:'lk'|'aca-exact'|'gdomain', mechanism, lk:LkConfig|null, aca:{k, L, h, phi, ct, mu, V, tcInj, pi}|null,
             noise:{sigma, rho1, quantum}, sampling:{dtS}, tEndFactor, artefacts:[{kind, …}], tags:[] }
truth = { sigmaC, sigmaCHyd, isip, pi, k, khmu, L, mechanism, regimeAtEnd, tcInj, eta, CL, Gamma }

PRiSM_dfit_cal = { calibrated:false, version:null, generator:null, n:0,
                   hitRate:{ high:null, medium:null, low:null }, cusum:{ k:0.5, h:5 }, thresholds:{} }   // placeholder (3.4a)
```

### 3.10 Events

| Event (window CustomEvent) | Fired by | Detail |
|---|---|---|
| `prism:dfit-updated` | 59 after each stored result or pick | `{what:'events'\|'isip'\|'closure'\|'classify'\|'frac'\|'aca'\|'unc'\|'triage'\|'pick'\|'all', source:'auto'\|'user'\|'undo'\|'restore'}` |
| `prism:dfit-model-updated` | 59 after a leak-off simulate or fit | `{kind:'simulate'\|'fit', ok}` |
| `prism:plot-hover` (generic, 02) | canvas with `opts.hoverEvent` | `{plotKey, x, y, index}` (bubbles) |
| `prism:well-changed` (existing) | DFIT writes with `source:'dfit'` | — |
| listened: `prism:dataset-loaded` | 59 | marks `st.dfit.summary.stale`, re-runs `events` if in DFIT mode |
| listened (3.4b): `wts:modbus-samples`, `wts:historian-updated` (document) | 59 while the live tool is open | samples → `LiveSession.push` |

DFIT never fires `prism:fit-updated` and never calls `PRiSM_setLastFit`.

### 3.11 Storage keys and project files

| Key | Contents | Cap | Travels in |
|---|---|---|---|
| `wts_prism_state` (existing) | adds `dfit` (§3.3) | `st.dfit` ≤ 100 kB (log condensed beyond 300 entries; corridor ≤ 60 points) | project `prism` module and `storage`; multi-well blobs |
| `wts_prism_dfit_hf` (new) | `{v:1, windows:[{kind:'shutin'\|'step'\|'flowback', t0 (h), dtS, n, pB64, pSurfB64\|null, qB64\|null, scale, offset}]}` delta-encoded int32 | ≤ 3 windows × 12,000 samples, ≤ 600 kB | `storage` (well-scoped automatically) |
| `wts_prism` (existing Data-tab text) | DFIT channels through the new 07 roles | existing | existing |

No new project module. 3.4b adds nothing persistent beyond `st.dfit.live.tags`.

### 3.12 Generic hook contracts (WPH)

```js
window.PRiSM_modeExt = window.PRiSM_modeExt || {};            // merge, never replace
// ext keys read by the shell (all optional except label):
//   label, testType, steps{1..5}, tabs{n:tab}, stepView{n:fn(host)}, defaultPlot, showsPlot(entry,key), showsModel(entry),
//   plotsTab{hide:[]}, note, rail(el), status(snap) → {1..5:bool}, analyse(opts) → Promise, onEnter(prev), onLeave(next),
//   reportHeader(model) → {title, keyRows, keyLine}, reportPlots[{key,title}], reportLegacySections, exportItems[{id,label,fn}]
window.PRiSM_undoExtras = window.PRiSM_undoExtras || {};      // {key: {get() → JSON-safe, set(v)}}
window.PRiSM_toolCatalogueExtra = window.PRiSM_toolCatalogueExtra || [];   // [{id, fn, group, title, sub, modes:[]}]
// 36: section fn may carry fn.modes = ['dfit'] and return {…, plots:[{key, title}]}
// 02: canvas._prismPointerOwner = fn(ev) → true to take the gesture; opts.hoverEvent → 'prism:plot-hover'
// 02/11: PRiSM_PLOT_REGISTRY[key].axes = {x:'lin'|'log', y:'lin'|'log'}
// 05: window.PRiSM_rng(seed) → () → [0,1)
// 36: window.PRiSM_reportKeyLine() → string, window.PRiSM_reportReady() → bool
```

### 3.13 Contract fixtures (`tests/_dfit-shapes.js`, WP0, frozen)

Exports `checkShape(name, obj) → {ok, errors:[path]}` for `DfitDataset`, `DfitInputs`, `DfitState`, `Prepared`, `Events`,
`Derivs`, `IsipResult`, `StepDown`, `Hammer`, `ClosurePick`, `Consensus`, `Classification`, `FracOutputs`, `Triage`, `AcaResult`,
`LeakPlot`, `Uncertainty`, `LkConfig`, `LkResult`, `LkFit`, `Identify`, `Design`, `LiveVerdict`, `ReportModel`, `HandoffPacket`,
`CaseSpec`, and fixtures `FIX.ds` (the reference DFIT of §4.21, 600 points, generated once from the research prototype and committed as
data), `FIX.state` (a complete `st.dfit` with a closure
range) and `FIX.aca` (example B). Every WP asserts `checkShape` on its outputs; WP6 builds against the fixtures until the engines
land. The helper changes only through the lead, together with this section.

---

## 4. Algorithms

Every formula below was re-derived and checked numerically in the research scripts; the values quoted are the acceptance vectors
of Appendix A. Symbols follow §3.0. Engine internals use consistent units (h, ft, psi, ft³, psi·h) and convert once at the
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
- **Resampler** `PRiSM_dfit_resample` (O(n), one pass): keep every pumping sample up to 2,000 (M4-style min/max per bin above);
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
- **Pipe friction.** v = 17.157·q/d² (ft/s; q bbl/min, d in); Re = 928·ρ·v·d/μ; laminar f = 16/Re; turbulent Colebrook (Fanning)
  through `WTS_flowline_friction.colebrook` (it returns Darcy; ÷ 4); dp/dL = f·ρ·v²/(25.8·d). Friction-reduced water:
  Δp = (1 − FR)·Δp_water, FR capped by Virk's asymptote (85 % at Re 549,856). Power law: Re_MR = 89,100·ρ·v^(2−n)/K·(0.0416·d/(3 + 1/n))^n,
  Re_crit ≈ 3,470 − 1,370·n, laminar dp/dL = K·v^n·((3 + 1/n)/0.0416)^n/(144,000·d^(1+n)), turbulent Dodge–Metzner. μ at the column
  temperature (`mu_w_meehan`).
- **Perforations:** Δp_perf = 0.2369·q²·ρ/(n²·d⁴·C_d²) (C_d 0.56–0.66 new; 37.6 psi for 12 × 0.40 in at 5 bbl/min, 8.43 ppg).
- **Near-wellbore (tortuosity), two-branch law:** Δp_nwb = b·q^β for q ≥ q_t, = b·q_t^β·(q/q_t) below (q_t default 0.1 bbl/min).
- **Friction bleed-off after shut-in:** V_w·c_w·dΔ/dt = −q(Δ). Pure q^½: 1/Δ = 1/Δ₀ + t/(b²·V_w·c_w) (reference: 1 psi after
  17.3 min); two-branch: exponential below q_t with τ = V_w·c_w·b/√q_t (1 psi after 1.8 min). The bracket [1.8, 17.3] min is
  ΔtD 0.4–3.5 for tp = 5 min — the whole early G window — so G_min is moved past the time when the predicted Δ < max(1 psi, 3σ),
  and the classifier tests this explanation before calling a PDL hump (§4.11).
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

### 4.3 Events and the pumping time (56) [H]

- **Pump start** t_start: first rate above 2 % of q_max (pressure ramp onset when q is missing). **Breakdown** t_b: pressure
  maximum followed by a drop while pumping. **Steps**: rate plateaus (within 1 %) of ≥ 5 s before shut-in. **Shut-in** t_s: rate
  below 5 % of the last stable rate, refined to sub-sample resolution between the last pumping and the first falloff sample (the
  largest negative pressure difference, refined by the hammer onset when a high-rate window exists). **Flowback**: q_fb > 0.
  **Cycles**: separate injection periods; a cycle is "closed before" when the pressure fell below the previous cycle's closure.
- **Wellbore stiffness** from the pre-breakdown ramp: V_w·c_w = q/(dp/dt) (5,637 psi/min expected for 5 bbl/min into 10,000 ft
  of 5½-in 20 lb/ft casing with c_w = 4e-6 1/psi). Compared with `WTS_tubulars` × water compressibility in triage.
- **Volumes:** V_i = ∫q dt; V_i,frac = V_i − V_w·c_w·(p_shut-in − p_start) − V_fill (fill detected from the delay between the rate
  start and the pressure rise).
- **tp definitions** (all stored, default `pump`, sensitivity shown): pump = t_s − t_start; breakdown = t_s − t_b;
  volume-equivalent = V_i / q_last. CL and xf hardly move with tp; Gc and η do (tp 5.0 / 3.5 / 6.0 min → Gc 18.00 / 21.87 / 16.28).
- **Ramp-down** > 10 % of tp makes the instantaneous shut-in undefined: the data-driven G (§4.5) becomes the default.
- **Idealised schedule** for C2: one step at q_eq = V_i,frac/tp_veq from t_s − tp_veq to t_s, then 0 (written to
  `PRiSM.multiRate` in bbl/d).

### 4.4 ISIP (56 + `WTS_wellbore`) [H]

At shut-in the BHP drops by Δp_perf + Δp_nwb (+ Δp_pipe at surface); then water hammer, friction bleed-off and pressure
redistribution follow. ISIP is the friction-free fracture pressure at t_s with the hammer removed. Four estimates:

1. **Water-hammer midline** (`hammerQuick`, needs ≥ 10 samples per period): fit p = a + b·t + A·e^(−t/τ)·cos(2πt/T + φ) over the
   first periods with `PRiSM_lm`, T started from the autocorrelation peak; ISIP_wh = a. Quick fallback: mean of the first peak and
   trough after the first full cycle. Family **wave**.
2. **Early-G extrapolation**: p = ISIP − m_G·G over [G_min, G_lin]; the window grows while residuals stay unstructured (runs test;
   line R² vs quadratic). **On G, never on √Δt** (for ΔtD ≪ 1, G ≈ (4/π)·g′(0)·ΔtD is linear in Δt): the reference data give
   7,600.0 on G and 7,622–7,628 on √Δt. PDL or tip-extension curvature: fit after the hump or label "extrapolated through a
   non-linear segment". Family **falloff**.
3. **Step-down intercept** p_frac (§4.14). Family **friction**.
4. **Last pump pressure minus friction**: ISIP_lp = p_inj,end − a·q² − b·q^β (− Δp_pipe). Same family as 3 (shared coefficients).

**Reconciliation:** inverse-variance mean over **families** (within a family the better-determined member), spread = max − min.
Label high when all families agree within max(10 psi, 2 % of pn), medium within 5 % of pn, low otherwise (outlier and likely
reason listed). The spread feeds pn, xf and CL in the uncertainty propagator but not Gc or η. **Log-log check:** the ISIP for which
early Δp and D keep the Nolte-curve ratio (§4.6); a wrong ISIP bends Δp while D is unchanged. Reference: wh 7,605, G 7,600.0,
sd 7,595.5, lp 7,599.4 → **7,600 ± 5 psia** (0.760 psi/ft at 10,000 ft).

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
  short injections. The α bounds differ by 5 % at ΔtD = 5 and < 2 % beyond 50; the α sensitivity is shown only when ΔtD,c < 5.
- Check values: G(1, ½) = 4/π = 1.27324; G(1, 1) = 1.40638; G(10, ½) = 6.3159; G(100, ½) = 23.5495; G(100, 1) = 23.8307.
- Every plot and the report state "G type: ideal α = ½ / ideal α = 1 / general α / data-driven".

### 4.6 Derivatives and the three diagnostic plots (56) [H]

- **Pressure-decline equation with storage:** C_sys·dp = −dV_L, C_sys = A_f·c_f + V_w·c_w, so
  dp/dG = −(π/2)·r_p·A_f·CL·√tp/(A_f·c_f + V_w·c_w) ≡ −m_G (Nolte's π·r_p·CL·√tp/(2c_f) when V_w·c_w → 0). Identities:
  dV_L/dG = V_f/G_c; C_sys = (V_f/G_c)/|dP/dG|; p_n = m_G·G_c (normal leak-off, any spurt).
- **One engine:** `PRiSM_compute_bourdet(x, y, L)` returns dy/d ln x. G·dP/dG = call with (G, ISIP − p); dP/dG = that ÷ G;
  √t·dP/d√t = 2 × call with (Δt, ISIP − p); dP/d√t = that ÷ √Δt; log-log D = call with (Δt or superposition time, ISIP − p). The
  derivative does not depend on the ISIP value. L default 0.1 (0.05–0.2 for G·dP/dG in the stability grid; 0.2–0.4 after
  closure). Derivatives only where a full window exists.
- **Superposition switch:** the log-log derivative uses the injection superposition time from the schedule when tp/Δt_end > 0.05,
  else Δt.
- **G_min** = the latest of: hammer end (3τ), predicted bleed-off end (§4.2), gauge thermal transient end, 1 % of the falloff;
  user-settable. ln G diverges as G → 0 and the earliest points carry friction dissipation.
- **G plot** (`dfitG`): p, dP/dG and G·dP/dG vs G, with the fitted early line and intercept, the tangent through the origin, the
  compliance early line, PDL-hump shading, pick markers per family and the consensus band.
- **√t plot** (`dfitSqrt`): p, dP/d√t and √t·dP/d√t vs √Δt (min^½ on display). Its inflection equals max |dP/dG| when ΔtD ≫ 1, so
  it is **not** independent of the tangent pick (§4.7).
- **Log-log** (`dfitLogLog`): ISIP − p and D vs Δt, with the **exact Nolte reference** instead of slope guides:
  Δp_ref = m_G·G(ΔtD), D_ref = m_G·ΔtD·G′(ΔtD) with m_G from the early window. The local slope d ln G/d ln ΔtD is 0.978 / 0.927 /
  0.785 / 0.617 / 0.539 at ΔtD = 0.01 / 0.1 / 1 / 10 / 100 (α = ½) — still ≈ 0.55 at a typical closure. D above the reference and
  rising = stiffening (contact, height recession, storage); below early = PDL or tip extension; turning over = after closure. A unit
  slope persisting past ΔtD ≈ 1 is the quantitative storage flag.
- **Compliance-versus-pressure** (`dfitCompliance`): C_rel(p) = |dP/dG|_open/|dP/dG(p)| (and C_sys = (V_f/G_c)/|dP/dG|) against
  pressure, x decreasing. Closure is a compliance drop at a pressure; the onset is contact, the floor is residual aperture plus
  storage. Stiffness ratio (dP/dG)_closed/(dP/dG)_open; residual compliance A_f·c_f,res = (A_f·c_f + V_w·c_w)·(dP/dG)_open/(dP/dG)_closed − V_w·c_w.

### 4.7 Closure methods (56) [H for the algorithms; the physics is disputed and shown as such]

All methods run on the same resampled data and derivatives; each returns a `ClosurePick`.

| Method (`method`) | Family | Algorithm | Main failure modes |
|---|---|---|---|
| Tangent (`tangent`) | F2 | The line y = s·G through the origin touches G·dP/dG where y/G is largest ⇔ **s\* = max dP/dG** (robust: smoothed, or the 95th percentile in a sliding window), over [G_start, G_peak], excluding G < G_min and the PDL hump. Pick = the last G with y ≥ (1 − ε)·s\*·G before y falls permanently below; ε = max(0.02, 3σ_y/(s\*·G)) | tangent drawn to a PDL hump (too early, too high); concave-up data (late, low if the compliance reading is right); wrong tp or t_s; storage-dominated (no departure) |
| √t inflection (`sqrt`) | F2 (`sameEvidenceAs:'tangent'` when ΔtD,c > 5) | max \|dP/d√t\| (or departure of √t·dP/d√t from a line through the origin) | multiple inflections (PDL, hammer, thermal); second-derivative noise; diverges from the tangent only when ΔtD,c is small |
| Max dP/dG (`maxdpdg`) | F2 (same evidence) | the G of the dP/dG maximum | as tangent |
| Compliance (`compliance`) | F1 | Fit y = a + b·G (through the origin when \|ι\| < 0.05) over the longest early window with unstructured residuals after G_min and after any hump; pick = first G after which y − (a + bG) > ε·(a + bG), ε = max(0.02, 3σ), held ≥ N points or ≥ 0.05 in log G. If the first departure is downward, the compliance and tangent picks coincide (families agree) | any other rising-dP/dG cause (height recession, gas break-out storage, gauge thermal drift); early line biased by PDL or tip extension; ε and noise sensitivity |
| Compliance drop (`crel`) | F1 (`sameEvidenceAs:'compliance'`) | first p where C_rel < 1 − ε for ≥ N points | as compliance |
| Log-log departure (`loglog`) | F1 | first upward departure D/D_ref > 1 + ε_ll (0.05) held ≥ 0.1 log cycle. Also reported (not used): the end of the reference-curve region and max D (after closure) | L smoothing shifts it by ≈ L/2 in ln Δt; superposition vs Δt; storage unit slope |
| Variable-compliance fit (`varcomp`) | F3 | Fit dp/dG = −K·f_L(p)/C_sys(p), C_sys(p) = A_f·c_f(p) + V_w·c_w, aperture law above σ_c: w = w_c + c_f0·(p − σ_c); below: w = w_res + (w_c − w_res)·e^(−(σ_c − p)/s_c), c_f = c_f0·e^(−(σ_c − p)/s_c), with a residual floor f_res·c_f0; after closure the Carter rate is damped by (p − p_r)/(σ_c − p_r). RK4 in G on the data grid; `PRiSM_lm` over ISIP, K, σ_c, s_c, f_res (optional C_d, p_fo), V_w·c_w and p_r fixed; data to 1.5 × G of the F2 pick | model dependence (aperture-law form); non-uniqueness with PDL; σ_c–s_c correlation when data stop soon after closure (reported) |
| Model closure (`model`) | F3 | σ_c from the leak-off mini-model fit (§5.7) when one exists (mechanical closure, contact onset) | embeds the contact law; shown as a cross-check, **not a vote** |
| Fissure closure (`fissure`) | F0 | end of the PDL hump (G·dP/dG returns within ε of the line through the origin) = p_fo | not main closure |
| User (`user`) | its own | a click, a drag or a typed value | logged with reason |

**Families and dependence.** F1 "first stiffening" marks the onset of compliance loss (contact or the start of height recession);
F2 "end of stiffening" marks the end of the concave-up section; they are two readings of the same physics, and the module shows both
with all downstream numbers. A √t or max-dP/dG pick never counts as confirming a tangent pick ("3 methods agree" is the commonest
false confidence).

**Failure-mode matrix** (what each method does when the cause is present):

| Cause | Tangent | √t | Log-log | Compliance | Var. compliance |
|---|---|---|---|---|---|
| PDL hump | early/high unless excluded | extra inflection | below the reference early | early line biased | needs the PDL term |
| Height recession | late/low by design | late | rises | early/high by design | ambiguous |
| Storage dominated | no departure | weak | unit slope | weak | needs V_w·c_w |
| Wrong tp / t_s | bends small G | minor | reference off | early line biased | ISIP/K biased |
| Gauge thermal drift | spurious | spurious | spurious | spurious trigger | misfit |
| Surface gauge on vacuum | invalid | invalid | invalid | invalid | invalid |
| Closure not reached | none | none | none | none | σ_c unbounded below |

**Toy contact illustration** (model-dependent): contact onset built into the data at 7,000 psi (exponential law, f_res 0.10,
s_c 100 psi). Compliance pick 6,998 psi, tangent pick 6,507 psi, √t 6,506 psi; pn 602 vs 1,093 psi; PKN xf ≈ 134 vs 75 ft;
χ = 1.00 vs 1.44 (the χ ratio flags the tangent pick as lying after the stiffening began).

### 4.8 Consensus, stability and the label (56; full detail in §6.2) [H for the arithmetic, M for the thresholds]

- **Stability grid** per method: L ∈ {0.05, 0.1, 0.2} × tp ∈ {pump, breakdown, veq} × t_s ± one sample × ε ∈ {2 %, 5 %} = 54
  settings, plus 50 block-bootstrap resamples of the de-trended residuals (block length max(5, round(2/(1 − ρ1))) ≤ 50, seeded) →
  P10/P50/P90 per method and per family (family = pooled samples of its independent members).
- **Single closure** when |P50(F1) − P50(F2)| ≤ max(50 psi, 1 % of σ_c) and both P10–P90 bands overlap: value = inverse-variance
  mean of the family P50s (σ_f = (P90 − P10)/2.563). **Closure range** otherwise: [P50(F2), P50(F1)], with the classifier's
  preferred reading and the consequences of each end (what-if table). **None** when dP/dG never departs: the board shows the
  closure-time forecast instead.
- **Label** (rule ids are evidence `K1…`): high needs all of R_vis > 0.7, band < 2 % of pn, ≥ 0.3 G-decade of data past the pick,
  σ_y/(s·G) < 2 % at the pick, χ within 0.9–1.1, single mode. Low if any of R_vis < 0.3, the F1 departure within 3σ, a vacuum or
  thermal flag overlapping the window, an unstable grid (spread > 2 % of pn). Medium otherwise. Not estimable when mode = none.
  3.4a labels say "uncalibrated"; 3.4b shows the calibrated hit rate next to the label.
- **Bounds veto** (`PRiSM_dfit_bounds`): p_i < σ_c < ISIP; η ∈ (0, 1); pn plausibility (warn > 0.5·(ISIP − p_i)); **frictional
  limit** σ_c ≥ p_p + (S_v − p_p)/[√(μ² + 1) + μ]² (÷ 3.119 at μ = 0.6; S_v from `rock.sigmaVGrad` × TVD). A vetoed pick is shown
  struck through and excluded from the consensus unless the user overrides it with a reason.

### 4.9 Efficiency, net pressure and the consistency ratio (56) [H]

```
η = (g_c − g0)/g_c = G_c / (G_c + 4·g0/π)
α = ½ : η = G_c/(G_c + 2);   α = 1 : η = G_c/(G_c + 16/(3π)) = G_c/(G_c + 1.698);   general: 4g0/π = 1.7531 (8/9), 1.8016 (4/5), 1.8823 (2/3)
with spurt: η = (g_c − g0)/(g_c + S_p/(CL·√tp))  → the no-spurt value is an UPPER bound
p_n = ISIP − σ_c        χ = p_n/(m_G·G_c)        gradients ISIP/TVD, σ_c/TVD (psi/ft), p_n/σ_c
```

- The **same α** for G and η (reported pair); closure at 305.1 min, tp 5 min → G_c 18.00, η 0.900 (α = ½) or G_c 18.276, η 0.915
  (α = 1). With a mini-model fit, the model's own α gives the "model-consistent η" (G_c/(G_c+2) underestimates η by up to 0.025 at
  intermediate efficiency).
- η depends on G_c, tp and t_s only, **not on ISIP**.
- χ > 1.1: compliance changed before the pick (typical of an F2 pick on concave-up data); χ < 0.9: early slope steepened (PDL,
  tip extension) or ISIP too low. χ goes into the evidence list, never alone into a label.

### 4.10 Compliance, CL, geometry, spurt, PDL, leak-off rate, forecast (56) [H; M for geometry inputs]

| Geometry | A_f (one face) | c_f | w_max/w̄ | Size from the closure balance V_f = η·V_i = A_f·c_f·p_n |
|---|---|---|---|---|
| PKN | 2·xf·h_f | π·h_f/(2E′) | 4/π | xf = V_f·E′/(π·h_f²·p_n) |
| KGD | 2·xf·h_f | π·xf/E′ | 4/π | xf = √(V_f·E′/(2π·h_f·p_n)) |
| Radial | π·R² | 16·R/(3π·E′) | 3/2 | R = (3·E′·V_f/(16·p_n))^(1/3) |

- **CL (storage-corrected):** CL = 2·m_G·(A_f·c_f + V_w·c_w)/(π·r_p·A_f·√tp) (→ 2·c_f·m_G/(π·r_p·√tp) without storage; tp in min
  gives ft/√min). r_p = min(1, h_p/h_f) for PKN/KGD; radial with h_p < 2R: r_p = (2/π)·[u√(1 − u²) + asin u], u = h_p/(2R).
- **Γ = r_p·CL/c_f** is the group the falloff determines (PKN: ∝ r_p·CL·E′/h_f); CL is printed "conditional on E′ = … and
  h_f = …".
- **Automatic geometry selection** (override allowed): radial if 2R ≤ barrier spacing; else PKN with h_f = barrier spacing if
  xf ≥ 1.5·h_f; else KGD (or PKN and KGD as bounds). Messages such as "radial 2R = 116 ft exceeds the 50 ft barrier spacing".
- **Spurt:** not determinable from the falloff alone. With independent geometry: S_p = [V_i − A_f·c_f·p_n − 2·r_p·A_f·g0·CL·√tp]/(2·r_p·A_f)
  (× 748.05 → gal/100 ft²); negative → "geometry inconsistent" (never clipped). Default 0 with the η upper-bound note.
- **PDL:** matrix power law CL(p) = CL_s·[(p − p_r)/(ISIP − p_r)]^n (n = 1 compressibility, ½ filtrate) with the **expected
  curvature** κ_exp = [(σ_c − p_r)/(ISIP − p_r)]^n − 1 (reference −0.19); fissure law CL = CL0·e^(C_d·(p − p_fo)) above p_fo, C_d
  by regressing ln[(dP/dG)/(dP/dG)_base] on (p − p_fo) over the hump (synthetic C_d 0.004 recovered as 0.00404); multiplier at ISIP
  e^(C_d·(ISIP − p_fo)) (4.06 in the example) for frac design; σ_H − σ_h = (1 − 2ν)·(p_fo − σ_h) (low confidence, caveats
  printed).
- **Leak-off permeability cross-check:** k [md] = 1000·(CL/(0.0374·Δp))²·μ/(φ·c_t), Δp = mean(p) − p_r over the falloff (reference
  2.64e-3 md for the PKN CL); agreement with the after-closure k within ×3 supports the geometry, a large mismatch points at r_p, h_f,
  E′ or fissure leak-off.
- **Leak-off rate from the data:** q_L(Δt) = (V_f/G_c)·(4/(π·tp))·dg/dΔtD; V_L − V_L(0) = (V_f/G_c)·G; V_f(Δt) = V_f·(1 − G/G_c);
  with PDL q_L = C_sys·|dP/dG|·dG/dt. Reference: 0.500 → 0.040 bbl/min from shut-in to closure; 22.5 bbl leaked by closure.
- **Closure-time forecast:** G_c,f = (ISIP − σ_prior)/m_G, Δt_c = tp·G⁻¹(G_c,f); ±0.02 psi/ft (±200 psi) brackets closure between
  2.46 and 8.63 h in the reference.
- **Height estimates** shown side by side: user / stress profile; radial-consistency; recession ratio h_f,0/h_f,end = √R_s (PKN-like)
  or R_s (KGD-like), R_s = (dP/dG)_late/(dP/dG)_early over the concave-up section; injection net-pressure slope (Nolte–Smith,
  indicative: ¼–⅕ contained PKN, negative KGD/radial or height growth, ≈ 0 barrier or fissures, unit restriction).
- **Thermal sensitivity:** dp/dT ≈ V_w·β/C_sys → ≈ 1 psi/°F before closure, ≈ 42 psi/°F after (C_sys → V_w·c_w).
- **Closure visibility** R_vis = A_f·c_f/(A_f·c_f + V_w·c_w): 0.977 water-filled reference, 0.54 gas-filled wellbore; < 0.3 low,
  0.3–0.7 medium.
- Failure modes: h_f unknown (PKN xf ∝ 1/h_f²: 20 % in h_f is 44 % in xf); dynamic E′ without correction; r_p = 1 in thin pay;
  spurt ignored (xf overestimated); complex fractures (transverse-storage flag).

### 4.11 Leak-off-type classification (56) [M]

Features over W = [G_min, G_c,tangent]:

| Feature | Definition | Normal | Matrix | PDL | Tip ext. | HR / contact | Storage |
|---|---|---|---|---|---|---|---|
| ι | a/(b·G_c) of G·dP/dG = a + bG over the lower 60 % of W | \|ι\| < 0.05 | ≈ 0 | > 0 early | > 0.1 | < 0 | ≈ 0 |
| κ | robust relative change of dP/dG from G_min to G_c | ≈ 0 | ≈ κ_exp (± 0.05) | < 0 then 0 | < −0.1 throughout | > +0.1 | ≈ 0 |
| H | max of (G·dP/dG − s·G)/(s·G) before the return, s from after the hump | < 0.05 | < 0.05 | > 0.05, spans ≥ 0.3 G and returns | no return | – | – |
| D/D_ref | log-log ratio to the Nolte reference | ≈ 1 | slightly < 1 | < 1 early | < 1 | > 1 rising | unit slope beyond ΔtD 1 |
| R_vis | §4.10 | – | – | – | – | – | < 0.3 |

- **Order of tests:** (1) the friction bleed-off and hammer explanations of an early hump (§4.2) and a gauge thermal transient;
  (2) storage; (3) the other classes.
- **Score** per class = mean over its conditions of a logistic margin σ((value − threshold)/(0.2·|threshold| + δ)); top class
  reported; any class within 0.15 is reported too (for height recession vs asperity contact this is the rule: one class
  `hr-contact` with both readings). Below 0.5 for every class → `undetermined`.
- **Evidence sentences** filled only with computed numbers, e.g. "dP/dG falls 21 % to closure; 19 % is expected from
  reservoir-controlled leak-off at p_r = 4,500 psia; no hump; classified normal (matrix-controlled)."
- Alternative causes listed for tip extension (wrong t_s or tp, matrix PDL with large pn/(ISIP − p_r), slow valve, thermal).

### 4.12 After-closure analysis (57) [H]

**Impulse kernels** (V bbl, t h, field units; a whole family Δp = 5.6146·V/(φc_t)·G_d(t)):

| Regime | Impulse Δp | Group | Specialised plot |
|---|---|---|---|
| Bilinear | 264.8·V·μ/[h·√(k_f w)·(φμc_t k)^¼]·t^−¾ | √(k_f w)·(φμc_t k)^¼ | p vs t^−¾ |
| Linear | 97.54·(V/A)·√(μ/(kφc_t))·t^−½ | A√k | p vs t^−½ |
| Radial | 1,694.5·V·μ/(kh)·t^−1 | kh/μ | p vs t^−1 |
| Spherical | 29,437·V·μ^1.5·√(φc_t)/(k_s t)^1.5 | k_s = (k_h² k_v)^(1/3) | p vs t^−³⁄₂ |

Every intercept is p_i. η_d = 0.0002637·k/(φμc_t) ft²/h. μ and c_t are **reservoir-fluid** values; V = injected minus flowback.

- **Time origin.** Carter leak-off is spread over 0 < τ < t_c with mean release time τ̄ = t_c/3, and both Nolte functions expand to
  ∝ 1/(t − t_c/3) and (t − t_c/3)^−½. Default t0 = τ̄ (t_c/3 or the mini-model centroid), shown in the axis label; options total
  time, mid-injection t_e/2 (no-fracture injections), time since closure. On a time-since-closure axis pure radial reads −0.52 at
  1.5 t_c and −0.65 at 2 t_c (looks linear); the centroid origin is within 3 % from 3 t_c.
- **Nolte / Talley functions** (t and t_c from the start of injection): F_L = (2/π)·asin√(t_c/t) (exact Carter convolution;
  F_L(2t_c) = 0.5), F_R = ¼·ln(1 + χ·t_c/(t − t_c)), χ = 16/π²; Carter-exact radial F_Rc = (χ/4)·u·artanh u, u = √(t_c/t), offered as
  an option (F_R/F_Rc = 0.9538 at 2 t_c). Cartesian lines p = p_r + m_L·F_L and p = p_r + m_R·F_R; **kh/μ = 4,181·V/(m_R·t_c[h])**
  (250,856·V/(m_R·t_c[min])); linear: m_L = 845.5·CL_p·√(μ/(kφc_t)) (CL_p ft/√min on the permeable area) ⇒
  k = μ/(φc_t)·(CL_p/(1.1827e-3·m_L))².
- **Properties used:** late radial kh/μ does not depend on the closure pick; linear-flow k scales with CL²·t_c and does (k is re-run
  over the closure band); V = 8·CL_p·h_p·L·√t_c links Nolte-linear and impulse-linear (ratio A_ACA/A_Carter is a QC number);
  λ = m_L/(p̄_frac − p_r) ≈ 1 means reservoir-controlled leak-off.
- **p_i-free diagnosis:** D(t) = |dp/d ln(t − t0)| (L_B 0.2–0.4; noise σ_D ≈ σ/(√2·L_B); an accepted regime needs D ≥ 10σ_D, i.e.
  Δp ≳ 35–50 σ_gauge; tides removed first through `PRiSM_tideAnalysis` / `PRiSM_applyTideCorrection`). Local slope
  s_D = d ln D/d ln(t − t0) = −n/2: linear −0.5 ± 0.07, bilinear −0.75 ± 0.07, radial −1.0 ± 0.07, spherical −1.5 ± 0.1, storage
  > −0.40, artefact/boundary < −1.6. Flow-dimension trajectory n(t) = −2s_D.
- **Bracket at every time:** p − 2D ≤ p_i ≤ p − D while n ∈ [1, 2]; point estimate p_i = p − (2/n)·D. Shown only where s_D is in
  [−1.1, −0.4]; failure cases: penny/spherical (true p_i above p − D: s_D still steepening past −1.1), after-closure storage
  (below p − 2D: s_D > −0.4), boundaries (D collapses).
- **Three brackets intersected:** Cartesian (F_L line ≤ p_i ≤ F_R line on the latest data), impulse lines (1/√t ≤ p_i ≤ 1/t),
  derivative; report the intersection and which method set each edge.
- **Sliding power-law fits** p = p_i + c·(t − t0)^(−n/2) are accepted only if s_D changes by < 0.1 across the window and the window
  starts after 3 t_c; otherwise only the bracket is reported (example B, 50–300 h gives n = 0.68, p_i = 4,321 vs 4,500).
- **p_i consensus:** candidates Nolte line (regime-appropriate), impulse line, derivative trajectory (flat over ≥ 0.3 log cycle),
  model match; weighted median inside the intersected bracket. High: width ≤ max(10 psi, 0.5 % p_i), regime stable ≥ 0.5 log cycle,
  ε < 0.05, match CI inside; medium: width ≤ 50 psi, or linear-only with F_L and impulse agreeing within 10 psi; low otherwise with
  the reason ("after-closure storage still active", "penny/spherical suspected", "surface gauge: column temperature not
  modelled"). p_i reported at the gauge and at the datum (reservoir-fluid gradient).
- **Transmissibility:** kh/μ primary (independent of φ and c_t); k = (kh/μ)·μ/h with h = net height by default (fracture height
  offered); a radial line over t_DL ≈ 1.6–5 overestimates kh/μ by 5 → 2 % — never underestimates. Uniform-flux slope −0.950 at
  t_DL = 1.60 and −0.980 at 4.10; linear ends at t_DL ≈ 0.084; radial recognisable (−0.90) at 0.76. Penny in a thick zone passes −1
  at ηt/R² ≈ 0.2 on its way to −3/2 (**false radial**).
- **Bounds when radial is not reached** (k ∈ [k_lo, k_hi], binding constraint named, evaluated at the conservative ends of the input
  ranges):
  - k_hi (trend): kh/μ ≤ 1,694.5·V/(Δp_end·(t_end − t0)) (needs p_i) and ≤ 1,694.5·V/(D_end·(t_end − t0)) (p_i-free); direction
    reverses for a spherical-type trend (n > 2).
  - k_hi (radial not reached, s_D > −0.9 at t_end): k < 0.76·φμc_t·L_max²/(0.0002637·(t_end − t0)).
  - k_lo (linear with the largest plausible area): k = (97.54·V/(A_max·m_L′))²·μ/(φc_t).
  - k_lo (leak-off cannot exceed its reservoir-controlled limit): k ≥ μ/(φc_t)·(CL_p,lo/(1.1827e-3·Δp_hi))² with
    **Δp_hi = p̄_frac,hi − p_i,lo** (the largest plausible driving pressure; see Appendix B, correction 2).
  - Example B: [0.0039, 0.0131] md contains the true 0.0100 md (binding: A ≤ A_max at 80 ft; trend at 300 h).
- **Before-closure k** (when the falloff ends before closure or as a cross-check): the CL → reservoir-controlled relation (§4.10,
  labelled with λ) and the mini-model fit with k as a parameter (§5.7). **No empirical closure-time correlation is shipped.**
- **Model-library match** (§6.8): impulse → constant-rate transform t·Δp_imp = 24·V·Δp′_u (t h, V bbl, unit rate 1 STB/d;
  radial gives 24 × 70.6 = 1,694 V·μ/(kh)).
- **Afterflow fraction** ε(t) = C_ac·(p − p_i)/V (C_ac = C_wb + C_res); straight lines valid for ε ≤ 0.05 (radial: ε = 1/(2τ), the
  slug-test criterion). ε is shown with C_wb only (lower limit) and with C_res from the 3.4b storage model.
- **3.4b:** variable-storage convolution model (q_inj − q_L = C(p_w)·dp_w/dt; p_face = p_i + Σ(q_j − q_j−1)·g(t − t_j−1);
  C(p) = C_wb + C_res + (C_f − C_res)·S((p − p_c)/w); Newton per step, O(N²), N ≤ 1,500) fitting p_i, k, L, C_res, p_c; generalised
  F_n from the actual leak-off history; tidal phase-lag kh/μ is not planned.

### 4.13 Gas (57) [H]

- Adjusted variables p_a = (μz/p)_i·∫_{p_i}^{p} p′/(μz) dp′ and t_a = (μc_t)_i·∫ dt′/(μc_t)(p(t′)), c_t(p) = S_g·c_g + S_w·c_w + c_f;
  every liquid formula then applies with μ_i and c_ti at p_i; V stays the injected water volume. F_L and F_R are evaluated in t_a with
  t_c,a = t_a(t_c).
- Reuse `PRiSM_mpTable` and `PRiSM_gasPseudoTime` (normalised at p_i); `WTS_gaspvt_z` when impurities matter.
- Forced when (p_c − p_i)/p_i > 0.1 or p_i < 3,000 psia. Iterate: liquid p_i⁰ → p_a, t_a → re-analyse → p_i; stop at |Δp_i| < 0.1 psi
  (2–3 passes); the iteration count is shown. The upper-bracket p_i sets c_t for a k lower bound.
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
- 3.4b: step-up/step-down hysteresis (b_up vs b_down) and a mini-hammer fit at every step (≥ 10 Hz).

### 4.15 Step-rate test (`WTS_wellbore.stepRate`, 3.4b) [H]

- **Continuous hinge** on end-of-step pressures: p = α + b₁·min(q, q\*) + b₂·max(0, q − q\*); q\* scanned continuously between
  the 2nd and the 2nd-to-last rate, linear LSQ at each q\*, minimum SSE; constraints b₂ < b₁, ≥ 2 points per side, F-test vs a single
  line (p < 0.05) else "no break". FEP = α + b₁·q\*; band from a 500-resample residual bootstrap. Example: q\* 1,805 bbl/d, FEP
  6,199.3 psia (P10–P90 6,186–6,217; true 6,204), b₁ 1.249, b₂ 0.037 psi/(bbl/d).
- **Superposition-corrected** (every sample): X = Σ_j (q_j − q_j−1)/q_n·log10(t − t_j−1), Y = (p_w − p_i)/q_n; matrix samples fall on
  Y = m·X + m·C₀ (m = 162.6·Bμ/(kh)); fit on the first steps (excluding 5 min after each change), then parting = first time the
  residual r = (Y − Ŷ)·q_n < −4σ_p for 3 consecutive samples. Example: k 9.95 md (true 10), departure 3.000 h (true 2.967 h). p_i from
  C1 or fitted (flagged). b₁ is never reported as an injectivity (matrix injectivity falls 12 % over nine steps with no fracture).
- Hall plot H(W) = ∫(p_w − p_e)dt with derivative D_H = W·dH/dW (D_H < H: fracturing; > H: plugging); slope
  141.2·Bμ(ln(r_e/r_w) + s)/(kh) (1.683 → 0.634 psi·d/bbl with a 100 ft fracture).
- Failure modes: b₂ > b₁ (matrix convexity, plugging, rising surface friction → "no break"); parted from the first step; two breaks;
  unequal steps (handled by the superposition form); thermal drift in tests > 12 h.

### 4.16 Pump-in / flowback and micro-pulses (`WTS_wellbore.flowback`, `.pulses`, 3.4b) [H]

- Storage balance C(p)·dp/dt = −(q_fb + q_L(p)), C = V_w·c_w + C_f (open) or + C_res (closed); at the flowback start
  C(p\*) = q_fb/(|dp/dt|_fb − |dp/dt|_fo), q_L(p\*) = C(p\*)·|dp/dt|_fo (reference 0.2140 ft³/psi, 0.080 bbl/min; slopes −2.10 →
  −28.3 → −405 psi/min, 14× steeper at closure), V_f ≈ C_f·p_n → η = 0.893 with no G-function.
- **Closure corrected for near-wellbore loss:** σ_c = p_w,knee + Δp_perf(q_fb) + Δp_nwb(q_fb) (+ pipe); the flowback-start pressure
  step measures the correction directly (141.5 psi at 1 bbl/min in the reference). Rebound peak ≤ σ_c ≤ corrected knee.
- Rate selection: q_fb ≥ 5 q_L, time to closure 5–30 min, correction ≤ 25 % of (p\* − σ_prior); ≈ ⅙–¼ of the injection rate.
- Micro-pulses (10–30 s bleeds): response 4.4 psi while open vs 62.5 psi after closure (0.5 bbl/min, 20 s); removed volume put
  back by superposition through C2 rate periods so the G-function and ACA still work.

### 4.17 Water hammer (`WTS_wellbore.hammerQuick` 3.4a; MOC 3.4b) [H]

- Wave speed c = c₀/√(1 + ψ·K·D/(E_s·e)), c₀ = √(K/ρ) (K in lb/ft² = psi × 144; K = 1/c_w from `cw_dodson`): 4,539 ft/s in 5½-in
  20 lb/ft casing. Gas (Wood): 1 % free gas at 3,000 psia cuts c to 3,289 ft/s, 3 % to 2,376 ft/s — the main reflector uncertainty.
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

### 4.18 Triage checks (56; the feature is §6.3)

Implemented as `PRiSM_dfit_triage` with the checks of §6.3; every threshold is a user-editable default stored in
`st.dfit.inputs.options.triage`.

### 4.19 Global failure modes and automatic responses

| # | Symptom | Likely cause | Automatic check | Response / label |
|---|---|---|---|---|
| 1 | After-closure slope ≈ −½ just after closure, turning to −1 | time-since-closure origin on radial data, closure proximity | slopes over the four origins | centroid origin; linear withheld |
| 2 | Slope −1 briefly, then steeper | penny / spherical | s_D still falling past −1.1 | penny kernel; k_s; no radial kh |
| 3 | Slope shallower than −0.4 after "closure" | closure picked too early; progressive closure; storage | s_D > −0.4; ε > 0.05 | re-check consensus; lines withheld |
| 4 | Late flattening, p_i too high | thermal afterflow, drift, column warm-back | BH T trend; ∫q_th/V > 2 %; surface-gauge column model | low confidence; thermal note |
| 5 | Radial k from the last points in shale | radial not reached | t_DL(t_end); trend direction | bounds only; T_app "upper bound" |
| 6 | Linear k far from radial k | wrong A, CL, r_p; height change; several fractures | A_ACA/A_Carter/A_geom | ratios shown; radial preferred |
| 7 | Early hump | bleed-off, hammer, gauge thermal, PDL | §4.2 prediction; dT/dt; hump span | G_min moved, or PDL with evidence |
| 8 | Pre-closure derivative dives at early time | wrong t_s or tp | ι > 0 with κ < 0 and no hump | "check shut-in time" warning |
| 9 | Surface pressure 0 / vacuum | p_w below the column head | p_s < 15 psig | data masked; BH gauge required |
| 10 | Falloff flat or linear bleed right after shut-in | gauge isolated by the shut-in valve | closed-line signature | fail: "gauge on the pump side of the valve?" |
| 11 | Late decline linear in time, below p_i | leak | s_D ≈ 0; leak plot | leak rate + corrected p_i |
| 12 | Gas: F functions inconsistent | real time with large μc_t change | (μc_t)_i/(μc_t)(p_c) > 1.1 | adjusted variables |
| 13 | Nolte and impulse disagree near closure | t < 3 t_c, F_R vs F_Rc | window start / t_c | move the window; F_Rc |
| 14 | μ, c_t of the injected fluid used | input error | fluid type vs reservoir | reservoir values forced (C1) |
| 15 | Steeper than −1.6 late | boundary, wrong origin, cooling | plateau test with a bracket p_i | label only, no line |
| 16 | Supercharge from earlier operations | initial static ≠ C1 p_i | triage | note |

### 4.20 ▶ Analyse pipeline, slicing, cancel and budgets (59 orchestration; engines pure)

| Stage | Engine | Desktop budget (2,000-point falloff) | Unit size |
|---|---|---|---|
| prepare (+ conversion band when surface) | `PRiSM_dfit_prepare`, `WTS_wellbore.convert` | ≤ 60 ms (+ ≤ 40 ms band) | 1 unit |
| events, triage | `_events`, `_triage` | ≤ 30 ms | 1 |
| ISIP (incl. hammer fit when a window exists, step-down) | `_isip` | ≤ 80 ms | 1 |
| derivatives, picks | `_derivs`, `_closurePicks` (+ var-compliance fit) | ≤ 60 ms | 1 |
| stability grid | `_consensusJob` | ≤ 600 ms | 8 settings per unit |
| classify, frac outputs, what-if | `_classify`, `_frac`, `_whatIf` | ≤ 20 ms | 1 |
| ACA (+ gas iteration, + library match when requested) | `_aca`, `_acaMatchJob` | ≤ 150 ms (+ ≤ 800 ms match) | 1 model per unit |
| uncertainty | `_uncertaintyJob` | ≤ 60 ms | 250 draws per unit |
| evidence, report model, summary | 57 | ≤ 20 ms | 1 |

Jobs run through `PRiSM_autoInterp.drive(job, {shouldCancel, onProgress})`; `shouldCancel = () => cancelled ||
!(shell = document.getElementById('prism_shell')) || !shell.isConnected || PRiSM.mode !== 'dfit' || token !== currentToken`. Cancel keeps the previous
results and shows "Cancelled — previous results kept". One undo step wraps the run. The leak-off history match, the designer and the
uncertainty in "model-consistent" mode run from their own buttons, never inside ▶ Analyse. After the last stage, zero timers are
pending (smoke and `dfit-ui` U9).

### 4.21 Reference worked example (the synthetic vertical well used by every note)

Datum 10,000 ft TVD; slickwater 8.43 ppg (0.438 psi/ft); 5½-in 20 lb/ft casing; 12 perforations 0.40 in, C_d 0.6; 25 bbl at
5.0 bbl/min (tp 5.0 min); E′ 5.0e6 psi, h_f 50 ft, h_p 40 ft, p_r 4,500 psia, φ 0.06, c_t 1e-5 1/psi, μ 0.5 cp.

| Output | Value |
|---|---|
| V_w·c_w | 4.98e-3 ft³/psi (8.87e-4 bbl/psi); ramp 5,637 psi/min |
| Water hammer | c 4,539 ft/s; T 8.81 s quarter-wave → reflector 10,000 ft; Joukowsky 232 psi |
| Step-down | p_frac 7,595.5; 38 psi perforation + 315 psi tortuosity at 5 bbl/min; 11.9 of 12 open (P10/P50/P90 8.9/11.7/16.0) |
| ISIP | 7,600 ± 5 psia (0.760 psi/ft); surface equivalent 3,216 psia (constant gradient) |
| Falloff | p = 7,600 − 33.33·G (α = ½) to closure |
| Closure | 7,000 psia (0.700 psi/ft), Δt_c 305.1 min, ΔtD,c 61.02, G_c 18.00 |
| η | 0.900 (α = ½), 0.915 (α = 1); pn 600 psi; χ 1.00 |
| Geometry | PKN consistent: xf 134.0 ft, w̄ 0.113 in, CL 1.863e-4 ft/√min (storage-corrected 1.908e-4); KGD 57.9 ft / 4.315e-4; radial 58.2 ft / 4.377e-4 (r_p 0.429) |
| Leak-off | 0.500 → 0.0405 bbl/min shut-in → closure; 22.5 bbl leaked by closure; V_L during pumping 14.04 ft³ (all geometries) |
| k from CL | 2.64e-3 md (PKN) |
| R_vis | 0.977 |
| Forecast | σ 7,200 → 2.46 h; 6,800 → 8.63 h |

### 4.22 Defaults (all user-editable; "cal" = replaced by the 3.4b calibration table)

| Name | Default | Where |
|---|---|---|
| Rate thresholds pump start / shut-in | 2 % of q_max / 5 % of q_last | events |
| Resampling | 40 per decade; dpMin = max(0.05 psi, 3σ, 10 quanta) | prepare |
| Bourdet L (pre / after closure) | 0.1 / 0.25 ln units | derivs, ACA |
| Compliance and tangent ε | max(0.02, 3σ) | picks |
| Log-log departure ε_ll | 0.05 held ≥ 0.1 log cycle | picks |
| Single-closure tolerance | max(50 psi, 1 % σ_c) and overlapping bands | consensus |
| Label thresholds | R_vis 0.7 / 0.3; band 2 % pn; 0.3 G-decade; noise 2 %; χ 0.9–1.1 (cal) | consensus |
| Frictional coefficient μ, S_v gradient | 0.6, 1.0 psi/ft | bounds |
| ISIP agreement | max(10 psi, 2 % pn) high; 5 % pn medium | ISIP |
| Classifier tie margin | 0.15 | classify |
| ACA regime bands | ±0.07 (±0.1 spherical); storage > −0.40; artefact < −1.6 | ACA |
| ε afterflow limit | 0.05 | ACA, designer |
| Gas forcing | (p_c − p_i)/p_i > 0.1 or p_i < 3,000 psia; stop at \|Δp_i\| < 0.1 psi | gas |
| Atmospheric pressure | 14.696 psia | prepare |
| Uncertainty draws / seed | 1,000 / 1 | uncertainty |
| Designer draws / grid | 500 / coarse (≈ 232 steps) | designer |
| Leak tolerance ε | 0.05 | leak budget |
| CUSUM k, h (live) | 0.5, 5 (cal) | live |

---

## 5. The leak-off rate mini-model (58, WP4)

Prototyped in pure `Math.*` (≈ 330 lines, `shutin/dfit/_leakoff/lk.js`) with twelve verification cases; every number below came
from a run of that prototype. The prototype is a planning check: WP4 ports it to the file conventions and the §3.7 API.

### 5.1 What it answers

- Standalone, no data: "what leak-off rate do I get?" for a planned schedule, geometry, E′, fluid, CL and spurt — leak-off rate
  against time (wall, reservoir and spurt parts), cumulative loss, the volume partition (fracture / formation / wellbore),
  efficiency, closure time (mechanical and hydraulic), half-length or radius, widths, the pressure falloff and its own G-plot.
- Inverse quick answers: "what CL gives my observed closure time?" (≈ 25 runs, ≈ 0.1 s) and "what volume and rate give a visible
  closure within X h?" (coarse-grid scan).
- History match of a recorded DFIT: CL (or Γ), closure stress, pore pressure, contact scale, reservoir fraction, optionally E′ or
  height, toughness, PDL, spurt, with an identifiability report.

### 5.2 Equations

**Volume balance, every step** (exact):

```
V_w·c_w·(p_w,n+1 − p_w,n) + [V_f,n+1 − V_f,n] + ΔV_L,n+1 = Q_in = q̄·Δt
V_f = A(L)·W(p̄; L)                 W from the aperture law (W = c_f·p̄ for hard closure)
ΔV_L = f_PDL(p_m)·[H_open·ΔB_w + ΔB_c] + 2·S_p·(A_L,n+1 − A_L,n)
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
zero-toughness similarity constants (KGD 0.6152, radial 0.6955) **that were quoted from memory and must be verified before the
tests are frozen** (gate G4 in WP4; a corrected value only changes κ; until verified the UI labels KGD/radial pumping pressures
"viscous term uncalibrated"). `viscCal` multiplies κ. The additive transition over-predicts p̄ by up to ≈ 20 % between vertices;
the fit absorbs it through the **apparent toughness** (default K_Ic,app = 14,000 psi·√in reaches field-like net pressures:
456 psi tip + 140 psi viscous at xf = 134 ft). The UI and report say: "apparent toughness stands in for tip and scale effects; it
is not a rock property."

**Two-part leak-off** CL = C_w + C_c, reservoir fraction w_c = C_c/CL:

```
Abel form (exact for a piecewise-linear history):   V_Lw(t) = 2·C_w·∫₀ᵗ A_L(s)/√(t − s) ds ≡ 2·C_w·B_w(t)
reservoir-controlled (1-D Duhamel, actual pressure): V_Lc(t) = 2·C_c·∫₀ᵗ A_L(s)·Δp̂(s)/√(t − s) ds ≡ 2·C_c·B_c(t)
Δp̂(s) = (p_f(s) − p_r − δ(s))/Δp_ref,   C_c = Δp_ref·√(kφc_t/(πμ_r))   ⇔   k [md] = 1000·(C_c[ft/√min]/(0.0374·Δp_ref))²·μ_r/(φc_t)
segment integral (no cancellation): ∫_a^b y/√(T − s) ds = d1·[2·y_a + (2/3)·(y_b − y_a)·(1 + s_a/(s_a + s_b))],
                                    s_a = √(T − a), s_b = √(T − b), d1 = (b − a)/(s_a + s_b);  newest segment (T = b): √Δt·[(2/3)y_a + (4/3)y_b]
```

- C_w (filter cake / filtrate) is classical Carter, pressure-independent, active only while open (H_open = step-averaged open
  fraction: 1, 0, p̄_n/(p̄_n − p̄_n+1) when closing). It does not feed the reservoir pressure: with w_c = 0 the model is the classical
  G-function world and the pressure stays near σ_c after closure (banner "after-closure not modelled: wall-controlled leak-off").
- C_c carries leak-off through closure into after-closure linear flow with no switch: p − p_r → Ṽ·Δp_ref/(π·C_c·√t) for t ≫ t_c
  (Ṽ = V_Lc/(2A_L)), the impulse linear-flow law. **Default w_c = 1 for water-based DFITs**; w_c = 0 for verification and
  wall-building fluids.
- **PDL:** f_PDL = min(f_max, e^(C_d·(p − p_fo))) above p_fo (default p_fo = σ_c, f_max 50), applied at the mid-step pressure to both
  parts; optional Castillo power law for n ≠ 1.
- **Spurt:** 2·S_p per unit of new permeable area.
- **2-D far-field** (optional; pseudo-radial transition): δ(t) = Σ_j q_c,j·[D(t − t_j−1) − D(t − t_j)], D = P_2D − P_1D,
  P_2D = μ_r/(2πk·h_p)·p_D,uf(t_D), p_D,uf = √(πt_D)·erf(1/(2√t_D)) + ½·E1(1/(4t_D)), P_1D = μ_r/(2πk·h_p)·√(πt_D), t_D = ηt/xe²,
  xe = xf (PKN/KGD) or A_L/(2h_p) (radial); D tabulated on 600 log lags; history in 60 log bins (O(N·60)). Reference implementation
  for the test: `PRiSM_model_infiniteFrac(tD, {uniformFlux:true})`.

**Aperture laws** (closure signature; c/c_f0 = relative compliance):

| Law | p̄ ≥ 0 | p̄ < 0 (x = σ_c − p) | c/c_f0 |
|---|---|---|---|
| `none` (hard, Nolte) | c_f0·p̄ | 0 | 1 / 0 |
| `exp` (as the variable-compliance fit) | w_c + c_f0·p̄, w_c = c_f0·s_c | w_c − c_f0·[f_res·x + (1 − f_res)·s_c·(1 − e^(−x/s_c))] | f_res + (1 − f_res)·e^(−x/s_c) |
| `hyp` (hyperbolic, recommended when contact is on) | c_f0·(s_h + p̄) | c_f0·s_h²/(s_h + x) | 1/(1 + x/s_h)² |

Two closure times: **mechanical** (p_f = σ_c, the contact onset) and **hydraulic** (c/c_f0 = ½: x = s_h(√2 − 1) for `hyp`,
s_c·ln 2 for `exp`).

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
- **History sums** once per step, one loop with two accumulators (h_A for A_L, h_Y for A_L·Δp̂) sharing the kernel weights.
- **Per-step solve: one bracketed monotone scalar root** (Illinois). Fixed area: F_p(p) = V_w·c_w·(p + exc + Δp_nwb − p_w,n) +
  A·W(p − σ_c) − V_f,n + ΔV_L(p) − Q_in is non-decreasing in p, so bracketing always succeeds. Propagating (pumping and
  p\* − σ_c > p̄_prop): F_L(L) on [L\*, 1.5^k·L\*], first sign change = stable branch. Tolerances 1e-13 (p), 1e-10 (L); 10–25
  evaluations per step, each O(1).
- **Closing step:** step-averaged open fraction (continuous in p_n+1; a mid-step evaluation made a 0.2 ft³ balance error in an early
  prototype). Reported t_c by event location (bisection of the crossing step to |p_f − σ_c| < 0.01 psi); tests extrapolate the last
  two open samples linearly in G (exact for Nolte: G_c 18.00394 on every grid from 117 to 3,301 steps).
- **Stability:** the history is explicit but exact and only the newest segment is implicit, so there is no step limit (an explicit
  newest segment would go unstable after closure once Δt ≳ (C_sys·Δp_ref/(2C_c·A_L))², 0.16 h in the reference).
- **Guards:** V_w·c_w ≥ 1e-6 ft³/psi; L ≤ 5,000 ft; ≤ 200 bracket expansions ("geometry runaway"); NaN guard on every committed
  state → `{ok:false, why, step}` with the partial result kept for plotting; a run budget (`budgetMs`, `Date.now()` checks; never a
  timer); a volume-balance audit with a warning above 1e-6·V_i; validity diagnostics (t_Dxf at t_end, L/h_f for PKN ≥ 1.5 and KGD
  ≤ 1, 2R vs barrier spacing, p_tip/p̄_prop regime indicator, component shares).
- **Special functions:** erfcx by series (x < 3) and continued fraction (the naive product overflows near x = 27); E1 by series ≤ 1
  and continued fraction above; Nolte g from 56.
- **Cost** (desktop, prototype): 2.8 ms (N ≈ 470), 11 ms (≈ 890), 45–50 ms (≈ 1,840); far-field with log-binned history adds
  O(N·60). Phone ≈ × 3. Optional sum-of-exponentials kernel (≈ 40 terms, 1e-7 relative over 8 decades, O(N·40), 1–2 ms at
  N = 2,000) is phase 3 and keeps the direct sum as the test reference.

### 5.4 Verification (acceptance vectors; common inputs E′ 5.0e6 psi, h_f 50 ft, h_p 40 ft, σ_c 7,000, p_r 4,500 psia, 5 bbl/min, 25 bbl, μ 1 cp, V_w·c_w 4.98e-3 ft³/psi where storage is on)

| # | Case | Expected | Tolerance |
|---|---|---|---|
| V1a | Nolte falloff, α = 1, `prescribed` (A_p 13,404 ft², c_f 1.571e-5, CL 1.863e-4, no storage) | V_L = 2r_p·A_p·CL·√tp·g(ΔtD, 1) to 7.9e-15 rel; p = ISIP − m_G·G to 4e-9 psi; ISIP 7,610.003; η 0.91513; G_c 18.306 | 1e-10 rel / 1e-6 psi |
| V1b | same, α = ½ | V_L rel err 2.4e-5; \|p − (ISIP − m_G·G)\| ≤ 1.5e-3 psi; ISIP 7,599.93; η 0.90002; G_c 18.0039 (Δt_c 305.2 min); m_G 33.322 | 1e-4 / 0.01 psi |
| V1c | grid independence (117 … 3,301 steps) | G_c = 18.00394 | 1e-5 |
| V1d | storage in the G slope | ISIP 7,586.07; G_c = pn·(1 + V_wc_w/(A_fc_f))/m_G = 18.0040 (model 18.0039) | 1e-4 |
| V2 | Carter area, `constP` p̄ 600 psi, r_p 1, 30 min | A(t) = (q·w_e/(4πC²))·[erfcx(x) + 2x/√π − 1], x = 2C√(πt)/w_e, w_e = w + 2S_p; A(30 min) = 68,890.1 / 47,998.1 / 33,134.4 / 22,044.7 / 8,992.5 ft² for (CL, S_p) = (1.863e-4, 0) / (1.863e-4, 2) / (1e-3, 0) / (1e-3, 5) / (5e-3, 0) | 1e-4 rel |
| V3 | no-leak-off growth laws | exponents 0.8000 / 0.6667 / 0.4444 (viscous PKN / KGD / radial), 0.6667 / 0.4000 (toughness KGD / radial); L(5 min) 468.29 / 317.98 / 165.02 / 573.01 / 192.54 ft; η = 1.00000 | 1e-4 |
| V4 | efficiency limits (PKN, K_Ic 0, CL 1e-6 … 3e-2) | α_A → 0.800 and → 0.502; η_s → 0.998 and → 0.0049; η from G_c with the model's α within 5e-4 of η_s | 1e-3 |
| V5 | storage ramp (`p_bd` 9,500, p0 4,500) | dp/dt = 5,637.1 psi/min | 1e-6 |
| V6 | after-closure linear asymptote (w_c 1, 1-D) | ratio 1.0165 (20 h), 1.0059 (100 h), 1.0039 (200 h); slope −0.506 / −0.501 / −0.501 | slope −0.5 ± 0.01 at t ≥ 50 t_c |
| V7 | volume balance (full options, breakdown) | \|V_i − V_f − V_L − V_wc_w·Δp_w\| ≤ 1.05e-8 ft³ | 1e-6·V_i |
| V8 | cross-check with the pre-closure example (PKN, K_Ic,app 14,000, w_c 0, storage) | xf 133.8 ft, pn 596.3 psi, η 0.892, Δt_c 307.1 min vs 134.0 / 600 / 0.900 / 305.1 | 2 % |
| V9 | 2-D far-field (k 0.1 md, xe 170.7 ft) | slope −0.653 (t_D 0.15), −0.845 (0.61), −0.911 (1.51), −0.928 (3.03), −0.940 (6.03); Δp/radial impulse 0.955 (1.5), 0.977 (3.0) | slope < −0.9 for t_D > 1.5 |
| V10 | self-consistent G (Carter only) | dP/dG_gen = −32.487 constant to 1e-3 psi from 1 to 240 min, while dP/dG(α = ½) drifts −37.3 → −32.6 | 1e-3 psi |
| V11 | fit recovery (run A) | CL, σ_c, p_r inside the 95 % CI from a start ×1.5, +150 psi, −200 psi in ≤ 40 runs | inside CI |
| V12 | identifiable group (runs B, G, I) | r_p·CL·E′/h_f = 14.904 in all three | 1e-3 |

### 5.5 Outputs

`LkResult` (§3.7): p_w and p_f; optional surface pressure p_s = p_w − hydrostatic + Δp_pipe(q) via `WTS_wellbore`; L(t), A, A_L,
mean and maximum width (4/π·w̄ PKN/KGD, 1.5·w̄ radial); q_L = ΔV_L/Δt (bbl/min; bbl/d after closure on display) and its wall /
reservoir / spurt parts; cumulative V_L with the same parts, V_f(t), V_i(t); the wellbore volume V_w·c_w·(p_w − p_w,0) — the
**volume-partition** series; η(t) = V_f/V_i,frac and η of the pumped volume (they differ by the wellbore compression: 0.814 vs 0.916
in the breakdown example); events (breakdown, ISIP, last pump pressure, the ISIP drop split into near-wellbore and viscous
redistribution, t_c mechanical and hydraulic, G_c for α = ½, α = 1 and the model's own G); xf at shut-in and closure; k equivalent
to C_c; t_Dxf range; balance error; warnings.

**Model-derived G:** g(t) = B_w(t)/(2·A_L,s·√tp), G_gen = (4/π)·(g(t) − g(t_s)) — exactly the data-driven G of §4.5 with τ(a) from the
model, passed to `PRiSM_dfit_gFromHistory` as a `gSpec`. With it the reference falloff has a constant dP/dG (−32.487) where the
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

Step ④ → "Leak-off model" sub-view (and a Tools-drawer quick mode `PRiSM_renderDfitSandboxTool`), available with no dataset:

- **Inputs card** `#prism_dfit_lk_inputs` (`.card` / `.fg-item`): schedule (volume `#prism_dfit_lk_v` bbl, rate `#prism_dfit_lk_q`
  bbl/min, or "use the loaded test's schedule" `#prism_dfit_lk_usesched`), geometry select `#prism_dfit_lk_geom` (PKN / KGD / radial /
  auto), E′ `#prism_dfit_lk_ep` (1e6 psi), ν, h_f, h_p, injectate μ (cp), CL (ft/√min) with "reservoir fraction w_c"
  `#prism_dfit_lk_wc`, spurt, PDL (C_d, p_fo), aperture law and scale, σ_c, p_r, V_w·c_w (from the wellbore card), t_end, mode
  (propagate / prescribed / constP), apparent toughness with its label. "Run" `#prism_dfit_lk_run` (≈ 10–50 ms; also on change,
  debounced through the save debounce, only while the card is visible).
- **Quick table** (`table.dtable`): q_L at shut-in, 5, 25, 100 min and at closure; cumulative leak-off; η; t_c (mechanical,
  hydraulic); xf/R; w̄; V_L at closure and t_end; k equivalent.
- **Volume-partition bar** (`dfitLkQ` stacked: fracture / formation / wellbore against time) synced with a fracture schematic that
  deflates under the time cursor (`prism:plot-hover`).
- **Plots:** `dfitLkP` (p_w, p_f and data when loaded), `dfitLkQ` (q_L by part, cumulative), `dfitLkG` (the model's falloff on the
  α = ½, α = 1 and model-derived G axes, with dP/dG and G·dP/dG), `dfitLkGeom` (L and w̄).
- **Goal-seek** `#prism_dfit_lk_goal`: "CL for an observed closure time" (`lkSolveCL`) and "volume and rate for a visible closure
  within X h" (`lkGoalSeek`, coarse grid: closure "visible" when R_vis ≥ 0.7 and Δt_c ≤ X).
- **Always shown:** "This falloff fixes Γ = r_p·CL/c_f = … (PKN: ∝ r_p·CL·E′/h_f); CL is conditional on E′ = … and h_f = …" and the
  validity diagnostics as ⚠ lines.

### 5.7 History-match mode

- **Parameters** (transform, default bounds, prior source): CL (log, 1e-6–1e-1 ft/√min, pre-closure CL); w_c (linear 0–1, fluid
  type); S_p (log, 1e-3–20, fixed 0 by default); σ_c (linear, [p_ACA,end, ISIP], consensus); p_r (linear [0, σ_c], ACA); E′ (log
  0.3–10 × 1e6, logs ± 30 %); h_f (log, h_p–10 h_p, stress profile ± 20 %); K_Ic,app (log 500–50,000, from ISIP − σ_c − p̄_visc);
  s_h (log 1–2,000 psi) or s_c / f_res; C_d, p_fo; τ_x (3.4b); V_w·c_w (log ± 50 % around the ramp value).
- **Presets** (instead of a dozen check-boxes): "Falloff, closure" {CL, σ_c, s_h} with data to ≈ 2 t_c; **"Full test"
  (recommended)** {CL, K_Ic,app, σ_c, s_h, p_r, w_c}; "Geometry group" (Full test + E′ free, h_f fixed; the report states Γ, not
  E′); "PDL" (+ C_d, p_fo); "Spurt" (+ S_p, only with K_Ic,app and E′ fixed). Never more than one of {E′, h_f} free; K_Ic,app free
  only with E′ fixed; never w_c, C_d and τ_x together.
- **Objective:** pressure residuals (psi) on 200–400 log-spaced falloff times; injection weight 0 by default; optional derivative
  residuals on log(G·dP/dG) (weight 0.2), with the same Bourdet engine and L on data and model; optional MAP priors
  (ln θ − ln θ_prior)/σ_ln θ for E′, h_f, K_Ic,app; σ_p from the late-falloff first differences.
- **Initial guesses:** σ_c = consensus; CL = pre-closure CL of the chosen geometry; K_Ic,app inverted from ISIP − σ_c at the
  pre-closure xf; p_r = ACA intercept or σ_c − 0.5·(ISIP − σ_c); s_h = 0.3·(ISIP − σ_c); w_c = 1; V_w·c_w = ramp value. Multi-start:
  4 deterministic perturbations (CL ×/÷ 2, σ_c ± one consensus band, s_h ×/÷ 3); report how many starts reached the best χ².
- **Algorithm:** `PRiSM_lm(modelFn, data, params0, bounds, freeze, {logKeys, maxIter})`, modelFn = simulate on the fixed grid and
  sample at the data times; finite-difference Jacobian (n_p + 1 runs per iteration); run budget 400 runs and 5 s wall-clock (reported
  as such); exposed as a `Job` (one LM iteration per unit) so 59 runs it with progress and Cancel. Measured: 3 free 0.27–0.42 s,
  4 free 0.18–0.42 s, 5 free 0.6–0.9 s at N ≈ 600.
- **Uncertainty that is honest about model error:** (1) LM covariance s²·(JᵀJ)⁻¹ (tiny on perfect-model data: σ_c ± 0.1 psi);
  (2) inflate by √(n/n_eff), n_eff = n·(1 − ρ1)/(1 + ρ1) from the lag-1 autocorrelation of the residuals (4–14× on field data);
  (3) **structural spread**: refit with each aperture law (none / exp / hyp) and PDL on/off; the spread of σ_c, p_r and CL across
  structures with χ² within 1.5× the best is the reported closure-stress uncertainty; (4) profile likelihood on demand for σ_c and p_r
  (15 values, 3–6 s, as a Job); (5) Monte Carlo refits are phase 3 (needs the fast kernel).
- **Identifiability rules** applied and explained (synthetic history matches, σ_p 0.5 psi, 250 points to 100 h): the falloff fixes
  Γ (|corr| ≥ 0.997 among CL, E′, h_f, K_Ic,app; condition number 1e6–3e6); a wrong fixed height with E′ fixed fits badly (rmse
  19.6 vs 0.5 psi) and biases σ_c by 78 psi, while with E′ free it fits (0.82 psi) with σ_c fine but CL and E′ badly biased — "free
  one member of the group, read σ_c from that fit, report Γ"; spurt only through the propagation model; p_r needs after-closure data
  (± 9 psi with data to 1.5 t_c vs ± 0.24 psi to 21 t_c; corr(CL, p_r) 0.993); σ_c trades off with the contact scale (corr 0.58);
  w_c identifiable with after-closure data (± 0.004; corr with CL −0.84).
- **Plain-English sloppy-direction warning** when the smallest scaled Fisher eigenvalue is below 1e-4 of the largest, naming its
  two or three largest components: "E′ and fracture height cannot be separated by this test: only r_p·CL·E′/h_f = 14.9 is determined
  (±1 %). CL = 1.86e-4 ft/√min assumes E′ = 5.0e6 psi and h_f = 50 ft."
- The fit is stored in `st.dfit.lk.fit` and fires `prism:dfit-model-updated`; its σ_c becomes the F3 `model` pick; its area history
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
constants and an additive transition (KGD/radial constants pending verification); apparent toughness is not a rock property;
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
- **Drag-to-fit (3.4b).** With a recorded test loaded, the user grabs the model curve on `dfitLkP`. While dragging, 3 LM iterations on
  the coarse grid over {CL, σ_c, p_r} with a pseudo-observation (t\*, p\*) of weight 10/σ² keep it responsive; on release a full fit
  runs (fit grid) and the pseudo-observation is dropped. Uses the 02 pointer-owner hook. The residual plot and the identifiability
  warnings stay visible during the drag.
- **Tests** (`dfit-leakoff`): L1–L12 = V1–V12; L13 quick table on the base case (q_L 0.586 / 0.262 / 0.135 / 0.070 bbl/min,
  η 0.892, Δt_c 307.1 min, ±2 %); L14 `lkSolveCL` returns 1.863e-4 ± 2 % for Δt_c 307.1 min; L15 partition sums to V_i within
  1e-6; L16 simulate and fit leave `localStorage`, `PRiSM_state` and the event log unchanged (pure).

### 6.2 Closure consensus board

**Algorithm** (on ▶ Analyse, not on redraw):

1. Picks of §4.7 for every method, with `sameEvidenceAs` marking dependent members.
2. Stability grid (§4.8: 54 settings + 50 seeded block bootstraps per method; F1 and F2 families pooled from independent members).
   A small heat map of the family P50 against (L, tp) flags an unstable pick (spread > 2 % of pn).
3. Bounds veto (§4.8) per pick and per family band.
4. Mode single / range / none and the value or range (§4.8). Preferred reading from the classifier: normal or matrix → "families
   agree"; `hr-contact` → "ambiguous: the F1 end is the contact (compliance) reading, the F2 end the end of stiffening (tangent)
   reading"; PDL → "after the hump"; storage → "low visibility".
5. Label with every rule listed (fired or not) and its number (evidence `K1…K9`): R_vis, band width, data past the pick, noise at the
   pick, χ, mode, vacuum / thermal overlap, stability, veto. 3.4a: "uncalibrated rule label"; 3.4b: hit rate from `PRiSM_dfit_cal`.
6. **Counterfactual line.** Knobs: compliance ε (2 % → 20 %), L (0.05 → 0.4), tp choice, G_min (× 0.5 → × 3), noise multiplier
   (× 1 → × 5), ISIP (± spread). For each knob, bisect (12 iterations) the normalised change u ∈ [0, 1] at which the F1 pick enters the
   F2 band (or vice versa); report the cheapest knob through a template filled only with computed numbers, e.g. "The compliance pick
   reaches the tangent band only if the contact threshold exceeds 9 %, which is implausible at σ = 0.4 psi." None found → "No
   plausible setting change reconciles the families; the difference is interpretive." Plus the one measurement that would settle it
   (second-cycle reopening, flowback knee, longer shut-in), chosen by rule from the classification.
7. **Override.** "Use another value" opens `#prism_dfit_override` (dialog): value or method, reason (required, ≤ 300 characters),
   analyst name (from report options). Stored in `st.dfit.picks.closure` with `source:'user'`, logged, undoable; the board then
   shows "user override" in amber with the consensus beside it.

**UI** (Tab-2 panel `dfit-board`, step ③):

- The **closure strip** `dfitStrip` (canvas, full width, 120 px tall; 160 px on phones): pressure axis with ISIP and p_i markers; one
  P10–P90 bar per family (F1 blue, F2 orange, F3 grey, F0 dashed); a dot per method (dependent members hollow); the consensus value
  or the shaded range; the frictional-limit line; the **what-if marker** (draggable) that sets `st.dfit.picks.whatIf` and recomputes
  every downstream number with the fast chain (§6.6).
- Under the strip: `.rbox` "Closure" with `.rrow` value/range, gradient (psi/ft), label and its rules (`<details>` list), "Why this
  pick?" buttons per method (`#prism_dfit_why_<method>`) that switch the main plot to the method's plot and highlight its window;
  the counterfactual line; the stability heat map (a 3 × 3 `table.dtable` coloured by deviation); "Use another value"
  `#prism_dfit_override_btn`.
- Verdict line, e.g. "⚠ Closure range 7,000–7,365 psia (medium, uncalibrated): the contact and end-of-stiffening readings differ by
  365 psi; the classifier cannot separate height recession from asperity contact."

**Tests** (`dfit-closure`): C1 toy contact (f_res 0.10, s_c 100): F1 6,998 ± 5, F2 6,507 ± 10, √t marked same-evidence, mode range,
χ(F2) ≈ 1.44; C2 pure Carter normal: families agree within 50 psi → single, label high; C3 PDL hump: tangent excludes the hump
(pick after G_fo), F0 = p_fo within 15 psi; C4 storage-dominated (gas wellbore, R_vis 0.54): label medium or low with the R_vis rule
fired; C5 closure not reached → mode none, forecast shown; C6 frictional veto: a pick below p_p + (S_v − p_p)/3.119 is vetoed and
excluded; C7 counterfactual names ε on the toy case; C8 determinism: the same seed gives identical bands, sync = job; C9 stability
grid ≤ 600 ms on 2,000 points; C10 a user closure passed in `ctx` replaces the consensus in `frac` and the what-if table and is marked
`source:'user'` (the UI round trip with log, undo and reload is `dfit-ui` U6 and `dfit-integration` I6). Test signals are built with
`PRiSM_dfit_vcModel` (the forward model of the variable-compliance fit), so WP2 needs neither the mini-model nor the generator.

### 6.3 Triage and data-health gate

**Checks** (`PRiSM_dfit_triage`; pass / warn / fail; thresholds editable; each with an evidence id `Q1…`):

| Check | Pass | Warn | Fail |
|---|---|---|---|
| Units and time base | mapped, monotonic | gaps > 1 % of the record | reversals, unknown units |
| Clock alignment | \|offset\| ≤ 1 s or corrected | corrected by > 2 s | events contradict |
| Wellbore stiffness (ramp vs `WTS_tubulars` × c_w) | ratio 0.5–2 | 2–4 | > 4 (air or gas, leak, open fracture) |
| Surface liquid-supported | p_s > 15 psig throughout | 0–15 psig | < 0 psig in the analysed window |
| Static hydrostatic check (p_w − p_s vs model before pumping) | within 2 % | 2–5 % | > 5 % |
| Gauge isolation | falloff shows hammer or a falloff shape | – | flat or linear bleed (closed-line signature) |
| Sampling vs hammer | ≥ 10 per 2L/c | 3–10 | < 3 (hammer not analysed) |
| Shut-in duration | < 2L/c | 2L/c–4L/c | > 4L/c (Joukowsky QC off) |
| Step-down quality | ≥ 4 steps over ≥ 60 % of the rate range | 3 steps | < 3 or < 30 % range |
| Surface-gauge friction share | Δp_pipe < Δp_perf at the top rate | 1–3 × | > 3 × (n_p not determinable) |
| Bleed-off window | G_min past the predicted Δ < 1 psi | within 2 × | picks inside the bleed-off |
| Volume reconciliation (∫q dt vs straps / strokes, fill excluded) | ≤ 5 % | 5–10 % | > 10 % |
| Temperature channel | BH T present | surface only | none, with a surface-gauge ACA |
| Gauge thermal transient | \|dT/dt\| < 1 °F/min after G_min | – | above, inside the pick window |
| Derivative noise | σ_D < 5 % of D at the pick | 5–15 % | > 15 % |
| Thermal (corr(detrended p, wellhead T) when T exists) | < 0.3 | 0.3–0.6 | > 0.6 inside a pick window |
| Leak signature (after closure) | power-law decay | s_D ≈ 0 over 0.3 cycle | – (leak plot, §6.4) |
| Tides / barometric (ACA) | removed or < 10 % of Δp | 10–30 % | > 30 % |
| Annulus communication | none | – | p_ann correlated with pumping |

- **Pressure-gradient plot** `dfitGradient`: BHP/TVD (psi/ft) against time with 0.433 psi/ft hydrostatic, the stress-gradient
  prior band, ≈ 1.0 psi/ft overburden and the ISIP/closure gradients; BHP above the overburden line flags a horizontal-plane fracture,
  at or below hydrostatic flags vacuum.
- **Blunder library.** Hypotheses, each an exact transform of the data or inputs: psig read as psia (+ atm; evidence: the source unit flag, or a reading within ±2 psi of zero while the well is open to atmosphere before pressure-up); kPa / bar / MPa read as
  psi (× 0.145 / 14.5 / 145); MD used as TVD (survey); gauge depth used as datum (ρ·ΔTVD); time unit s ↔ min ↔ h (pump time outside
  1–60 min); bbl/d ↔ bbl/min (× 1440, volume vs straps); ± 1 h clock. Each hypothesis is scored with the priors (ISIP gradient
  lognormal around 0.8 psi/ft, 0.55–1.1 at P1–P99; hydrostatic within 2 %; pump time; volume) as a Bayes factor against "as
  entered"; BF > 10 is flagged with the fix (one click applies it, logged); "it is real" dismisses and logs.
- **Early "re-pump?" verdict** (first hour, advisory, needs an "Acknowledge"): R1 no breakdown and ISIP gradient > 1.0 psi/ft
  (horizontal or no fracture); R2 ISIP gradient outside 0.55–1.1 psi/ft (unit or depth blunder, or not a fracture); R3 ΔISIP_nwb
  (= last pump − ISIP − pipe friction) > 30 % of (ISIP − σ_prior) (tortuosity dominated: re-pump at higher rate or with a viscous pill);
  R4 measured V_w·c_w > 2 × theory (air or gas: circulate and re-pump); R5 early log-log unit slope persists past ΔtD = 1 (storage
  dominated: closure may be invisible); R6 Joukowsky mismatch > 50 % (rate record or valve); R7 V_i,frac < the designer's V_min. Verdict
  "repump" on any fail among R2/R4/R7 or two warnings, "caution" on one warning, else "continue".
- **Salvage plan:** the usable windows and what each still supports, e.g. "Use 0.2–31 h for closure; surface data after 31 h are on
  vacuum; p_i not observable from this gauge."
- **UI:** Tab-1 panel `dfit-triage` with a traffic-light tile `#prism_dfit_triage_light`, the check table (`table.dtable`), blunder
  cards with "Apply fix" `#prism_dfit_blunder_apply_<id>` / "It is real" `#prism_dfit_blunder_dismiss_<id>`, the re-pump verdict with
  `#prism_dfit_repump_ack`, the salvage list; usable windows shaded on `dfitHistory`.
- **Tests** (`dfit-triage`; artefacts built inline in the test, no dependency on the generator): T1 each check fires on its artefact
  (12 artefacts, one case each); T2 psig blunder found
  (BF > 10) and the fix restores the true ISIP gradient; T3 bbl/d vs bbl/min; T4 MD-as-TVD with a deviated survey; T5 vacuum masks the
  converted data after p_s < 0; T6 clock offset 37.4 s recovered within 0.2 s; T7 re-pump verdict on an air-in-well case (R4) and on a
  clean case (continue); T8 thresholds passed in `inputs.options.triage` change the levels.

### 6.4 Leak budget and leak plot

- **Leak budget** (designer and step ①): a leak q_k biases the after-closure signal by 2·q_k·t/V relative to the impulse (k, h and
  xf cancel: constant-rate linear Δp = m·q·√t against impulse V·m/(2√t)); the tolerance for a shut-in of t_end is
  **q_k,max = ε·V/(2·t_end)** (ε = 0.05; 25 bbl and 300 h → 0.050 bbl/d). Pressure-test hold time to prove a leak below q_k,max:
  t_hold = 5σ_p·V_w·c_w/q_k,max (σ 0.05 psi, V_w·c_w 8.87e-4 bbl/psi → 6.4 min), valid only when thermal drift during the hold is
  below 5σ_p (stated). Prototype check: biases 0.018 / 0.063 / 0.181 for 0.02 / 0.07 / 0.2 bbl/d against the rule's 0.020 / 0.070 /
  0.200 — about 10 % conservative.
- **Leak plot** (after closure, t′ = t − t0 ≥ 2 t_c, inside the regime band): a leak adds −m·q_k·√t′ to the linear impulse, so
  y_lin = −2·t′^1.5·dp/dt′ = A + B·t′ with q_k = (B/A)·V/2 (bbl/h, × 24 for bbl/d); radial form y_rad = −t′²·dp/dt′ = A + B·t′ with
  q_k = (B/A)·V (bbl/h). Theil–Sen regression; CI by block bootstrap. **Detection floor** = the q_k at which B differs from 0 at 2σ
  (stated next to the result; the prototype read 0.021 bbl/d with no leak). **Leak-corrected p_i** = median over the window of
  p − A/√t′ + B·√t′ (linear form), shown beside the uncorrected value with the note that a window bias remains (+7.5 psi in the
  reference case even with no leak). Prototype: 0.018 / 0.068 / 0.199 bbl/d recovered (after the baseline) for 0.02 / 0.07 / 0.2;
  corrected p_i 4,507–4,508 against 4,461 uncorrected at 0.2 bbl/d (truth 4,500).
- **UI:** step ④ ACA sub-view card "Leak check" with `dfitLeakPlot`, the q_k ± CI against q_k,max (✓ / ⚠), the corrected p_i and the
  floor; a temperature channel, when present, is cross-checked (a leak-like trend that follows T is labelled "thermal?").
- **Tests** (`dfit-aca`): A13 rule vs simulation within 15 %; A14 leak plot recovers 0.07 bbl/d within ± 0.02 after the baseline and
  reports the floor; A15 corrected p_i within 10 psi of truth at 0.2 bbl/d.

### 6.5 Pre-job designer

- **Inputs** (`DesignRanges`, Tools drawer `PRiSM_renderDfitDesignerTool`, also usable from step ① with no data): k (P10/P90,
  lognormal), φ, c_t, μ_res, h, h_f (barrier spacing), h_p, E′, ν, closure-gradient prior (P50 ± sd), p_i gradient prior, wellbore
  (strings via `WTS_tubulars`, datum TVD, fluid), gauge (surface / BH, σ, resolution, sample rate), planned V and q (or "suggest"),
  allowed shut-in (days), target p_i precision W.
- **Ensemble:** 500 seeded Latin-hypercube draws; each runs the mini-model on the coarse grid (≈ 1.2 ms) → t_c, L at closure, η, V_f,
  the pressure curve (sampled at 60 log times for the corridor). Then the after-closure timing (hours): radial recognisable
  t ≈ 2,894·φμc_t·L²/k; within 5 % t ≈ 6,068·φμc_t·L²/k; **confirmed over ½ cycle (kh/μ ± 2 %) t_shut ≈ 18,962·φμc_t·L²/k**;
  impulse validity t ≥ 3 t_c; afterflow t ≥ 33,889·C_ac·μ/(kh); signal at radial onset Δp = 0.4468·V/(t_DL·φc_t·h·L²) ≥ 35–50 σ_gauge
  (independent of k); p_i bracket width W: linear t_W = (m_L′/(2W))² with m_L′ = 97.54·(V/A)·√(μ/(kφc_t)), radial
  t_W = 1,694.5·Vμ/(khW). **Recommended shut-in = max(t_shut, 3 t_c, t_ε, t_W)** as P10/P50/P90 with the binding criterion named.
- **Outputs:** outcome label "closure only" / "linear: p_i ± W" / "radial: kh/μ ± x %" (the class reached by ≥ 50 % of draws within
  the allowed shut-in) with a sentence saying the width comes from the k range; t_c P10/P50/P90; V_min ≈ C_ac·(p_c − p_i)/ε_max
  (7.5e-4 × 2,500/0.05 = 37.5 bbl; 19 bbl at ε_max 0.10); predicted R_vis; vacuum risk ("surface gauge sufficient for closure; BH
  gauge required for ACA"); water-hammer sample rate (≥ 10 per 2L/c); gauge resolution and drift for the ACA goal; leak budget and hold
  time (§6.4); a 5-step step-down plan (from the treating rate to ≈ 20 %, 10–30 s each); pre-job precision from `lkFisher` on the
  planned schedule (σ(p_i) ± 7.9 / 2.8 / 1.5 / 0.9 / 0.56 / 0.39 psi at 1.5 / 2 / 3 / 5 / 10 / 20 t_c in the reference, × the n_eff
  factor); an execution checklist (pressure test, air removal, anti-freeze in gauge dead spaces, one clock plus a marker blip, ≥ 60 min
  concurrent recording with the pump unit, shut-in valve on the pump side of the gauge, no step-down when closure, p_i and k are the
  objectives unless a friction split is needed); the **P10–P90 pressure corridor** saved to `st.dfit.plan.corridor` for the live view.
- **Planning reference cases** (afterclosure scripts): conventional oil (k 5 md, L 40 ft, V 10 bbl) radial recognisable 1.7 h, ± 2 %
  6.6 h; tight gas (k 0.01 md) 9.4 d / 36.8 d with ≈ 1 psi signal; shale gas (k 1e-4 md) 3.4 yr / 13.5 yr → "plan for p_i and
  bounds on k".
- **UI:** a printable `.card` set ("Design basis", "Expected outcome", "Shut-in", "Gauge and sampling", "Checklist") with
  `#prism_dfit_des_*` inputs, `dfitPlan` (corridor and timeline with the regime onset bands), and "Save plan" (to `st.dfit.plan`) /
  "Print checklist" (report capture). Phone layout: one column; the checklist as check-boxes (autosaved as ticks in `st.dfit.plan`).
- **Tests** (`dfit-designer`): D1 deterministic with seed; D2 conventional / tight / shale reference outcomes and times within 5 %;
  D3 V_min formula; D4 vacuum predictor on the reference column (p_s 195 / 96 / −3 psia for p_w 4,500 / 4,400 / 4,300); D5 500 draws
  ≤ 1 s desktop as a Job (stepped synchronously in the test).

### 6.6 Uncertainty budget and what-if propagator

- **Inputs** (each with a distribution and provenance shown next to the results): E′ lognormal (σ_ln 0.15 default), ν uniform
  ± 0.05, h_f triangular (h_p, input, barrier spacing or 1.5 × input), h_p ± 10 %, μ_res / c_t / φ lognormal (0.1 / 0.3 / 0.1), tp
  choice discrete (pump / breakdown / veq, equal weights), ISIP ~ N(consensus, spread/2), **closure resampled from the consensus
  stability samples** (F1 and F2 pooled with equal weights in range mode, so the output stays bimodal), p_i from the ACA consensus
  (normal truncated to the bracket). Rank correlations (Iman–Conover): E′–ν 0, φ–c_t −0.3 (editable).
- **Chain per draw** (microseconds, closed form): G_c(σ_c) by monotone interpolation of p(G); η with matched α; p_n = ISIP − σ_c;
  V_f = η·V_i,frac; c_f by geometry; xf or R; widths; storage-corrected CL and Γ; k from CL; after-closure k (linear needs CL; radial from
  kh/μ); p_i.
- **Shares:** first-order variance index S_i = Var(E[Y|X_i])/Var(Y) estimated by binning X_i into 20 quantile bins (no extra runs);
  the closure (interpretation) share is shown apart from the parametric shares. Tornado: one-at-a-time P10/P90 of each input.
- **What-if marker:** dragging it on the strip recomputes the fast chain for that closure, updates the frac-outputs card, the rail
  (labelled "what-if") and the frac-design sheet preview, and releases back to the chosen closure on Escape or "Reset".
- **UI:** step ④ "Uncertainty" sub-view: an outputs `table.dtable` (P10 / P50 / P90 / unit / largest driver / Ev.), per-output share
  bars (inline in the table for report capture), the tornado (`table.dtable` with inline bars), the seed and n (`#prism_dfit_unc_n`,
  `#prism_dfit_unc_seed`), "Re-run" `#prism_dfit_unc_run`.
- **Tests** (`dfit-uncertainty`): U1 determinism (seed); U2 with all inputs fixed and a single closure, P10 = P50 = P90 equals the
  deterministic chain; U3 the range case gives a bimodal closure and xf with closure share > 60 %; U4 shares sum within [0.8, 1.2] on
  an additive test function; U5 1,000 draws ≤ 60 ms.

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
- **Tests** (`dfit-leakfit`): F4 the group sentence appears for run B (E′ and h_f free) with Γ = 14.904 ± 1e-3; F5 the extension table
  reproduces the §6.5 σ(p_i) sequence within 10 %; F6 the ranking puts "longer shut-in" first for run F (data to 1.5 t_c).

### 6.8 After-closure match with the PRiSM model library, and the hand-off packet

- **Transform:** for t′ ≥ 3 t_c from the centroid origin, the constant-rate-equivalent derivative is y(t′) = t′·(p − p_i)/(24·V)
  (psi per STB/d); the p_i-free form is t′²·|dp/dt′|/V·(1/24) = Δp′_u·(1 − d ln Δp′_u/d ln t). y is flat for radial, +½ for linear,
  +¼ for bilinear, so any PRiSM model's pd′ applies.
- **Match:** p_model(t′) = p_i + 24·V·Δp′_u(t′)/t′ with Δp′_u = (141.2·μ/(kh))·pd′(t_D), t_D = 0.0002637·k·t′/(φμc_t·L²), pd′ from
  `PRiSM_MODELS[key].pdPrime` (Stehfest weights reused); p_i solved linearly for each (k, L, shape) by variable projection and
  bounded by the bracket; k and L (and shape parameters such as FcD) by `PRiSM_lm` (log keys) on ≤ 120 log-spaced points;
  candidates `infiniteFrac` (uniform flux), `finiteFrac`, `homogeneous`, `radialComposite`; BIC selection; CIs from the Jacobian plus a
  profile on L when only linear flow is present. Gas: in adjusted variables.
- **Hand-off packet** (`PRiSM_dfit_handoff`): PTA `setWell {testType:'falloff', tShut: ts, tp: tp_veq, pwf0: ISIP, pi}` (pi only when
  its label is ≥ medium; otherwise listed as a blocker the user can override), `multiRate` idealised schedule, model by regime, seeds
  `{xf: geometry P50 or match L, k: match k or kh/μ·μ/h}`; RTA `{k, kLo, kHi, source}`; frac sheet rows. Confirm dialog lists every
  change and blocker; the transient-mode C3 then floats xf, k, S.
- **UI:** step ④ ACA sub-view "Model match" card: model check-boxes, "Match" `#prism_dfit_aca_match`, the `dfitCrDeriv` plot (y and
  the model on log-log), a results `.rbox`; hand-off buttons `#prism_dfit_to_pta`, `#prism_dfit_to_rta`, `#prism_dfit_frac_csv`.
- **Tests** (`dfit-aca`): A10 the transform reproduces 1,694.5 on example A late data (± 0.5 %); A11 `infiniteFrac` match recovers k
  0.0100 ± 5 % and L 50 ± 10 ft on example B and keeps p_i inside the bracket; A12 BIC picks `homogeneous` on example A late data;
  `dfit-integration` I3 the PTA hand-off sets falloff, tShut, tp, pwf0, multiRate, model and seeds, and transient C2 sees Δp > 0 for
  ≥ 95 % of the falloff points.

### 6.9 Live co-pilot and replay

- **Engine** (`PRiSM_dfit_live`, 57, pure): an incremental pipeline over arriving samples — O(1) pressure-increment resampler (keep a
  sample when |p − p_last| ≥ dpMin or Δln Δt ≥ 0.01), closed-form G per sample, a two-pointer Bourdet window; ISIP from the first
  minutes (G extrapolation; hammer when ≥ 2 Hz); **closure detection** after the dP/dG minimum by a one-sided CUSUM on standardised
  residuals z_k of G·dP/dG from the early line, S_k = max(0, S_{k−1} + z_k − 0.5), "provisional" at S_k > 5, "confirmed" when the
  departure is held ≥ 0.05 log G with ≥ 0.3 G-decade of data after it (thresholds calibrated in 3.4b, false early calls ≤ 5 % on the
  benchmark replays); forecast before closure G_c = (ISIP − σ_prior)/m_G, Δt_c = tp·G⁻¹(G_c) with σ_prior ± 0.02 psi/ft (or the
  designer's prior); after closure the p_i bracket and t_W; optionally a warm-started 3-iteration mini-model re-fit (CL, σ_c, p_r;
  ≈ 50 ms) per block for the radial-onset forecast.
- **Verdict tile** (states): "continue: closure expected in 2.5–8.6 h" / "closure provisional at 7,010 psia" / "closure confirmed:
  7,000 psia (medium)" / "enough for p_i ± 25 psi" / "radial flow not reachable in the allowed time: plan for bounds on k" /
  "outside the designer corridor: check the gauge" (data outside P10–P90 for > 10 % of the last log cycle).
- **Replay** (3.4a): feeds a recorded dataset to the same engine in time order (synchronously in tests, as a Job in the UI) and
  records each verdict transition: "closure confirmed at 7.2 h; p_i ± 25 psi at 3.1 d; the test ran 9 d". Drawn as a conclusion
  timeline under `dfitHistory`.
- **Live listeners (3.4b, 59):** the Live tool lists `WTS_modbus.getTags()` and historian tags (resolved per call) for pressure (BH or
  surface), rate and temperature (`st.dfit.live.tags`); on `wts:modbus-samples` / `wts:historian-updated` (document), matching samples
  (psig → psia) are appended to the session and, if no job is running, one drive job processes the pending block (no other timer). The
  listeners and the session are released on route change, mode change, project Open/New and tool close. Surface data go through
  `WTS_wellbore.convert` with the last known column. Tap-to-log buttons (pump on/off, leak, rig-out, note) write `PRiSM_addEvent`
  entries (`note` / `open` / `close` types) on the data clock. 390 px layout: the verdict tile on top (≥ 44 px targets), the live plot
  inside the corridor, a loupe for picks.
- **Tests** (`dfit-live`): V1 replay of the reference case: provisional within 2 % of t_c after closure, confirmed before 1.5 t_c, no
  provisional call before t_c on 20 noisy seeds (≤ 1 false call); V2 forecast band brackets the true t_c; V3 the session handles
  out-of-order and duplicate samples; V4 psig samples are converted; V5 (3.4b) listeners are released on route leave and zero timers
  remain (`pendingTimers() === 0` after `flush(5000)`); V6 (3.4b) a synthetic `wts:modbus-samples` stream drives the tile through its
  states.

### 6.10 Evidence chips, pick log, quoted-value check, data + picks export

- **Evidence groups** (our own scheme, letters chosen so they do not clash in meaning with the build-up report): Q quality/triage,
  X conversion, E events, I ISIP, H water hammer, S step tests, G pre-closure derivatives, C closure (per family/method), K
  confidence rules, M mechanism (leak-off type), F fracture outputs, A after-closure, L leak-off model, U uncertainty, P plan, O
  overrides. Ids are `<group><n>` assigned in a fixed order by `PRiSM_dfit_evidence`; each item holds the values it quotes with their
  display precision and a path into the state.
- **Chips:** every reported number is followed by `[C1·C2·K1]` in the `.rv` text and an "Ev." column in tables; in the app the chips are
  buttons that open the plot and window behind the number.
- **Quoted-value check:** `PRiSM_dfit_checkQuoted` recomputes each quoted number from the state and fails when |quoted − recomputed| >
  half a unit in the last displayed digit; the report prints "Evidence check: n numbers, all recompute" or lists failures.
- **Pick log:** append-only `{seq, at, who, item, old, new, reason}` for every user pick, override, blunder fix, tp/α choice and hand-off;
  undo restores decisions but appends an "undo" entry rather than deleting history; capped at 300 (older entries condensed into one
  summary entry).
- **Data + picks export** (`PRiSM_dfit_exportText`): a plain ASCII file with a header block (well, datum, gauge, fluid, inputs and their
  provenance, app version, input/result hash16 when available), the events, every pick with method and band, the closure decision and
  log, the results with P10/P50/P90, then the resampled data (t h, p psia, q bbl/min, before/after-closure flag). Filename
  `dfit-<name>-<hash8>.txt`.
- **Tests** (`dfit-report`): R1 every headline number has ≥ 1 evidence id; R2 the quoted check passes on the reference and fails on a
  tampered model; R3 the report model lists the pick-log entries of `FIX.state` in order with their reasons; R4 the export contains the
  events, picks and the resampled data and parses back to the same t/p arrays (± display precision).

### 6.11 Interpretation lenses (3.4b stretch; first to cut)

- Two or three read-only, cited lenses, each a complete calculation chain with its own closure family and efficiency/geometry
  conventions: **contact chain** (F1 closure; matched-α η; CL and geometry from it), **tangent chain** (F2 closure; G_c/(G_c + 2)
  η; its conventional CL and geometry), **global-model chain** (the mini-model fit's σ_c and its own outputs). Lenses are labelled by
  method, never by person or school; their help text cites McClure et al. 2016 (SPE 179725), Barree, Barree & Craig 2009
  (SPE 107877), Nolte 1979 (SPE 8341) and Liu & Ehlig-Economides 2015 (SPE 174906).
- Compare view: outputs side by side and an exact Shapley breakdown of each difference over ≤ 4 elements (closure, efficiency
  formula, geometry convention, ISIP).
- Tests: the Shapley parts sum exactly to the difference; switching lens never changes stored picks.

---

## 7. User interface (59, WP6)

All DFIT element ids start with `prism_dfit_`. Numeric inputs are clamped on read (blank, 0, −1 and 1e12 never hang or produce
NaN text). All labels state field units. Controls are plain `input` / `select` (no `WTS_units.tagInput`).

### 7.1 Entering DFIT mode

- Header `#prism_testtype` gains "DFIT (fracture injection)". Selecting it calls `setMode('dfit')`; `ext.onEnter` sets the test type,
  writes the schedule (when a dataset exists) and opens step ①. The crumb reads "PRiSM · DFIT".
- With no dataset, step ① shows "Load a DFIT", "Build from gauge records" (19), "Load demo DFIT" `#prism_dfit_demo` (select:
  reference / tight linear / conventional radial / contact / PDL / surface gauge) and "Plan a DFIT" (opens the designer) and
  "Leak-off sandbox" (opens step ④ → Leak-off model). The sandbox and designer work without data.
- `#prism_units_note` shows in Metric mode exactly as in transient mode.

### 7.2 Step ① Data & events

Tab 1 (the existing Data tab: loader, column mapper with the new roles, crop) plus three panels:

- **`dfit-well` "DFIT well, wellbore and fluid"** (`.card` / `.fg-item`): datum TVD `#prism_dfit_datum_tvd` (required), datum MD,
  survey (paste box `#prism_dfit_survey`, "vertical" check-box), BH gauge TVD/MD, strings table (rows: tubular select from
  `WTS_tubulars` `#prism_dfit_str_<i>_key`, ID, top/bottom MD; + / − buttons), fluid select `#prism_dfit_fluid` (water / slickwater /
  gel / oil) with ρ (ppg), salinity, μ (cp), FR %, n′/K′ (gel), injection T; temperature model `#prism_dfit_tmodel` (static /
  displaced), surface T, gradient (°F/100 ft), τ_T band; perforations (shot holes, d, C_d); rock E′ (1e6 psi) with source select
  (static / dynamic-corrected / dynamic / unknown), ν, h_f, h_p, barrier spacing, overburden gradient, friction coefficient;
  reservoir block (p_i, φ, c_t, μ_res, h, T, fluid; read from and written to C1 with provenance badges "default / user / dfit /
  sample"). Missing required inputs show ⚠ lines, never NaN.
- **`dfit-channels` "Channels and bottomhole conversion"**: primary channel select `#prism_dfit_primary` (BH / surface), psig check-boxes
  per channel, atmospheric pressure, clock offset (auto / manual, "Apply" after confirmation), conversion summary (`.rrow`: hydrostatic,
  friction at q_last, band width at shut-in), `dfitConv` plot (surface, converted BHP with band, BH when present), vacuum ⚠.
- **`dfit-triage` "Test triage"** (§6.3) and the `dfitGradient` plot.
- **Events** are shown on `dfitHistory` (p, p_surf, q, T; event markers). Detected events can be dragged (pointer-owner) or typed in an
  events table (`#prism_dfit_ev_tstart`, `_tb`, `_ts`, flowback); tp choice `#prism_dfit_tp` (pump / breakdown / volume-equivalent)
  with the G_c / η sensitivity line; α select `#prism_dfit_alpha` (auto / ½ / 1 / general / data-driven).

### 7.3 Step ② ISIP & friction (step view)

- **ISIP card**: the four candidates (`table.dtable`: method, family, value, se, status), the consensus with spread and label, a
  verdict line, and "Use another ISIP" (override with reason). `dfitIsip` plot: early falloff on G with the extrapolation line, the
  hammer midline and the step-down intercept marked.
- **Water-hammer card** (only when a high-rate window exists; otherwise "Water hammer not resolvable at 1 Hz: record ≥ 2.3 Hz at the
  wellhead"): `dfitHammer` (window with the fitted damped sinusoid), period, regime, reflector depth vs perforation MD, Joukowsky check,
  hammer end time (sets G_min).
- **Step-down card** (when steps exist): `dfitStepDown` (p vs q with the fitted curve and the perforation / tortuosity split), the
  results table (p_frac, a, b, β, se), open perforations P10/P50/P90 with driver, label, refusal reasons, and the predicted friction
  bleed-off curve drawn on the early falloff.
- **Injection net pressure** (BH gauge only): `dfitInjNet` (log-log net pressure vs time since breakdown with slope guides ¼, 0, −¼,
  1), labelled "indicative".

### 7.4 Step ③ Pre-closure (tab 2)

- The plot picker (mode-filtered) shows `dfitG` (default), `dfitSqrt`, `dfitLogLog`, `dfitCompliance`, `dfitHistory`, `dfitGradient`,
  `dfitStrip`. The smoothing-L input stays (it sets `st.dfit.inputs.options.L`); period picker, time-function select and overlay are
  hidden (`ext.plotsTab.hide`). "Reset view" and zoom work as today.
- Panels: `dfit-board` (closure strip, label, why, counterfactual, stability, override), `dfit-classify` (type, scores, alternatives,
  evidence sentences, PDL and height-recession numbers), `dfit-frac` (η with the α pair, pn, χ, gradients, Csys, R_vis, Γ with the
  conditional CL, geometry with the automatic choice and messages, spurt note, leak-off-rate table and `dfitQL`, closure forecast when
  not reached, thermal sensitivity), `dfit-whatif` (one row per candidate: method, σ_c, G_c, Δt_c, η (½, 1), pn, χ, CL, xf/R, w̄, q_L
  at closure).
- The existing `linetools` panel shows the DFIT tool group for the active plot.

### 7.5 Step ④ After-closure & model (step view with a segmented control `#prism_dfit_s4_tabs`)

- **After-closure**: origin select `#prism_dfit_aca_origin` (centroid / total / mid-injection / since closure), L_B, F_R form
  (`#prism_dfit_aca_frc` Carter-exact), tide removal (auto / on / off), gas (auto; iteration count shown); plots `dfitAcaLogLog`
  (Δp and D vs t − t0, regime bands, noise band, bracket shading), `dfitFlowDim`, `dfitFL` / `dfitFR` (Cartesian with lines and
  brackets), `dfitImpLin` / `dfitImpRad`, `dfitPiTraj`; tables: brackets (method / lower / upper / edge), p_i consensus with label, kh/μ
  and k with the bias direction, bounds (method / value / direction ≤ ≥ ≈ / binding / Ev.), A_ACA/A_Carter and λ, ε; cards "Model match"
  (§6.8) and "Leak check" (§6.4); hand-off buttons.
- **Leak-off model**: §5.6 (sandbox) and §5.7 (history match: preset select `#prism_dfit_lk_preset`, "Fit" `#prism_dfit_lk_fit`,
  progress and Cancel, results with CI and inflated CI, structural spread button, Γ sentence, residual plot `dfitLkRes`).
- **Uncertainty**: §6.6.
- **What this test can tell**: §6.7.

### 7.6 Step ⑤ Report (tab 7)

The PRiSM report view in DFIT mode: header from `ext.reportHeader` (title "DFIT interpretation — <well>", key rows: ISIP, closure
(value/range + label), closure gradient, pn, η, Γ/CL, xf, p_i, kh/μ or k range), the DFIT section (§2.10), the report-options panel
`dfit-report-opts` (include uncertainty columns, include pick log, include data + picks appendix, analyst name), and the export
buttons (PDF, CSV, data + picks ASCII, frac-design CSV).

### 7.7 Tools drawer (registered through `PRiSM_toolCatalogueExtra`, `modes:['dfit']`, group "DFIT")

| Tool | Function | Increment |
|---|---|---|
| DFIT designer (pre-job) | `PRiSM_renderDfitDesignerTool` | 3.4a |
| Leak-off sandbox (quick) | `PRiSM_renderDfitSandboxTool` | 3.4a |
| Replay a recorded DFIT | `PRiSM_renderDfitReplayTool` | 3.4a |
| Water hammer (detail) | `PRiSM_renderDfitHammerTool` | 3.4a (MOC fit 3.4b) |
| Live DFIT co-pilot | `PRiSM_renderDfitLiveTool` | 3.4b |
| Step-rate test | `PRiSM_renderDfitStepRateTool` | 3.4b |
| Flowback & pulses | `PRiSM_renderDfitFlowbackTool` | 3.4b |

### 7.8 Rail in DFIT mode

Rows (each with its evidence chip and label colour): ISIP ± spread; closure value or range + label (+ "user override" / "what-if"
badges); closure gradient (psi/ft and ppg equivalent, with a copy button); pn; η (α); Γ and CL (conditional); xf or R (model);
p_i + bracket + label; kh/μ or [k_lo, k_hi]; triage light; live verdict (3.4b); "results stale — ▶ Analyse" when
`summary.stale`. Below 1,024 px the rail is the existing bottom sheet.

### 7.9 Plots (registry key → content; all `mode:'dfit'`, real `fn`, `_prismAxes`, picks via `dfit-picks`)

| Key | x | y (left / right) | Overlays | Step |
|---|---|---|---|---|
| `dfitHistory` | t (h) lin | p, p_surf (psia) / q (bbl/min), T | events, usable windows, replay timeline, live corridor (3.4b) | ① |
| `dfitConv` | t lin | p_s, converted p_w with P10–P90 band, BH | vacuum time | ① |
| `dfitGradient` | t lin | p_w/TVD (psi/ft) | 0.433, prior band, 1.0, ISIP and closure gradients | ① |
| `dfitIsip` | G lin | p | extrapolation line, hammer midline, step-down intercept | ② |
| `dfitHammer` | t (s) lin | p (psia) | fitted damped sinusoid, period marks | ② |
| `dfitStepDown` | q (bbl/min) lin | p_settled | fit curve, perforation / tortuosity split | ② |
| `dfitInjNet` | t − t_b log | p_n,inj log | slope guides | ② |
| `dfitG` | G lin | p / dP/dG, G·dP/dG | early line, tangent, compliance line, hump shading, picks, consensus band | ③ |
| `dfitSqrt` | √Δt (min^½) lin | p / dP/d√t, √t·dP/d√t | picks | ③ |
| `dfitLogLog` | Δt (min) log | ISIP − p, D log | Nolte reference Δp_ref and D_ref, picks | ③ |
| `dfitCompliance` | p (psia) lin, decreasing | C_rel (and C_sys) | onset and floor | ③ |
| `dfitStrip` | p (psia) lin | families (rows) | bars, dots, range, frictional limit, what-if marker | ③ |
| `dfitQL` | Δt (min) log | q_L (bbl/min) / V_L (bbl) | closure | ③ |
| `dfitAcaLogLog` | t − t0 (h) log | Δp, D log | regime bands, noise band, slope guides −½, −¾, −1, −³⁄₂ | ④ |
| `dfitFlowDim` | t − t0 log | n(t) | bands 1, 1.5, 2, 3 | ④ |
| `dfitFL`, `dfitFR` | F_L, F_R lin | p | lines, intercepts, bracket | ④ |
| `dfitImpLin`, `dfitImpRad` | (t − t0)^−½, (t − t0)^−1 | p | lines | ④ |
| `dfitPiTraj` | t − t0 log | p_i bracket band and trajectory | consensus | ④ |
| `dfitCrDeriv` | t − t0 log | t·(p − p_i)/(24V) log | model curve | ④ |
| `dfitLeakPlot` | t′ lin | y_lin or y_rad | regression line | ④ |
| `dfitLkP`, `dfitLkQ`, `dfitLkG`, `dfitLkGeom`, `dfitLkRes` | t, t, G, t, t | model vs data; partition stack; G family; L, w̄; residuals | — | ④ |
| `dfitPlan` | t (h, d) log | corridor P10/P50/P90 | regime onset bands, shut-in recommendation | tools |
| `dfitStepRate`, `dfitHall`, `dfitFlowback` | — | — | — | 3.4b tools |

### 7.10 Picks and interactions

- Click tools (§2.7) and drag handles commit through `PRiSM_dfit_setPick`, which records an undo snapshot, appends to the log and runs
  the fast chain (≤ 50 ms) so all plots, the rail and the what-if table update at once; bands refresh on the next ▶ Analyse (the rail
  shows "bands stale").
- Escape cancels an armed tool or a drag. Ctrl/Cmd-Z and Ctrl-Y undo picks (via `PRiSM_undoExtras.dfit`).
- The override dialog `#prism_dfit_override` (modal `<dialog>`, `.rp-skip data-rp-nosnap` so it is neither captured nor
  autosaved) asks for the value or method and a reason (required).
- Linked cursor across the visible DFIT canvases through `prism:plot-hover`.

### 7.11 Verdict lines (plain text, each under 299 characters; numbers filled from results)

| Code | Level | Text |
|---|---|---|
| TRIAGE_OK | ✓ | Test interpretable: all data-health checks pass. |
| TRIAGE_VACUUM | ✗ | Surface pressure reaches 0 psig at 31.2 h: converted data after that time are not used. Closure is unaffected; p_i needs a bottomhole gauge. |
| TRIAGE_AIR | ⚠ | Pre-breakdown ramp is 3.1× slower than the wellbore model: air or gas in the well, a leak or an open fracture. Closure visibility may be low. |
| BLUNDER_PSIG | ⚠ | The surface channel reads 0.2 psi before pressure-up with the well open to atmosphere, so it is probably psig: add 14.7 psi or confirm the data are absolute. |
| ISIP_LOW | ⚠ | ISIP methods disagree by 46 psi (low): the step-down intercept is the outlier; the steps may be unsettled. |
| CLOSURE_SINGLE | ✓ | Closure 7,000 psia (0.700 psi/ft), high confidence (uncalibrated rule label): both method families agree within 12 psi. |
| CLOSURE_RANGE | ⚠ | Closure range 6,507–6,998 psia (medium): the contact and end-of-stiffening readings differ by 491 psi; every downstream number is shown for both. |
| CLOSURE_NONE | ⚠ | No closure yet: dP/dG has not departed. Forecast with a 0.70 ± 0.02 psi/ft prior: 2.5–8.6 h after shut-in. |
| CLOSURE_VETO | ✗ | The tangent pick 6,410 psia is below the frictional limit 6,520 psia (μ 0.6, overburden 1.0 psi/ft) and is excluded unless overridden. |
| CLASS_DUAL | ⚠ | Concave-up G·dP/dG: height recession and asperity contact fit equally well (scores 0.71 and 0.68); the closure range reflects this. |
| CLASS_MATRIX | ✓ | dP/dG falls 21 % to closure; 19 % is expected from reservoir-controlled leak-off at p_r 4,500 psia; classified normal (matrix-controlled). |
| ACA_FALSE_RADIAL | ⚠ | Slope reached −1 and kept steepening (−1.32): penny-shaped fracture suspected; no radial kh/μ is reported. |
| ACA_BOUNDS | ⚠ | Radial flow not reached: k between 0.0039 and 0.0131 md (limited by the largest plausible area and by the trend at 300 h). |
| ACA_PI | ✓ | p_i 4,500 psia, bracket 4,494–4,506 psia (high): three methods agree. |
| LEAK | ✗ | Leak of 0.20 ± 0.03 bbl/d detected (tolerance 0.05 bbl/d for this shut-in): leak-corrected p_i 4,508 psia vs 4,461 psia uncorrected. |
| LK_GROUP | ⚠ | E′ and fracture height cannot be separated by this test: only r_p·CL·E′/h_f = 14.9 is determined (±1 %). CL assumes E′ 5.0e6 psi and h_f 50 ft. |
| LK_TOUGH | ⚠ | Apparent toughness 14,000 psi·√in stands in for tip and scale effects; it is not a rock property. |
| DESIGN_SHALE | ⚠ | Radial flow is not reachable within 30 days for these ranges: plan this DFIT for closure, p_i and bounds on k. |
| DESIGN_VACUUM | ⚠ | At p_i the surface pressure would be below 0 psig: a surface gauge is enough for closure, but after-closure analysis needs a bottomhole gauge. |
| HANDOFF_BLOCK | ⚠ | p_i is low confidence and is not handed to PTA unless you include it explicitly. |
| HAMMER_NA | ⚠ | Water hammer not resolvable at 1 Hz: record ≥ 2.3 Hz at the wellhead through shut-in to use it. |

### 7.12 Report capture

Every card follows the capture classes (§2.10). Tables carry an "Ev." column; verdict divs use ✓ / ⚠ / ✗ plain text; canvases sit in
`.chart-wrap`; the schematic is an SVG with `role="img"`; the override dialog and tool drawers are `.rp-skip`. The PRiSM job-report
snapshot (Quick Report) captures the DFIT section through the two host lines. PNG export of any DFIT plot includes the picks (post-draw
hook runs with `exporting:true`).

### 7.13 Phones (390 px) and iOS

- One column; plots at 0.75 × width (existing rule); the strip at 160 px; tables scroll horizontally inside `.dtable-wrap`; the rail is
  the bottom sheet; the step-④ segmented control wraps to two rows.
- Drag handles get a 24 px touch radius; the canvases keep `touch-action: pan-y` except while a handle is held.
- Live tool (3.4b): verdict tile first, buttons ≥ 44 px, tap-to-log row, loupe.
- iOS (`html.ios-app` only, in `ios-styles.css`): form controls ≥ 16 px (existing rule), the override dialog safe-area padding (§2.3),
  44 px tile buttons. No change to the web layout for iOS.

### 7.14 Accessibility and GUI sweep

- Canvases get `role="img"` and an `aria-label` summary from `PRiSM_plot_finish`; the strip's aria-label reads the families and the
  consensus; drag handles have keyboard equivalents (focusable marker buttons; arrow keys move by one resampled point, Shift × 10).
- The GUI sweep visits DFIT mode steps ①–⑤, the four step-④ sub-views and every DFIT tool, enters blank / 0 / −1 / 1e12 into every
  numeric input, tries every select option and scans for NaN / undefined / Infinity / null / [object Object]; DFIT must produce none.

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
| `lk` — the leak-off mini-model (58, called at call time) | whole tests: breakdown, propagation, optional step-down, shut-in, closure, after-closure (w_c > 0); mechanisms Carter normal, reservoir-controlled, fissure PDL, asperity contact (hyp / exp with several scales), spurt, storage-dominated (large V_w·c_w, e.g. gas-filled wellbore), tip extension and multi-cycle (3.4b engine) | closure picks, classifier, ISIP, frac outputs, history-match recovery |
| `gdomain` — closed-form G-domain decline (the variable-compliance model of §4.7 integrated in G, plus a decaying extra-area term for tip extension and a compliance step for height recession) | pre-closure signatures not yet in the 3.4a mini-model (tip extension, height recession) | classifier coverage in 3.4a |
| `aca-exact` — exact convolution of a Carter source with the full-height uniform-flux, penny or box kernel (§4.12) | after-closure data with known p_i, k, L (examples A and B and variants), radial, linear, penny/spherical | ACA, brackets, bounds, library match |

**Artefact injectors** (each a pure transform with its own seed stream): white noise (σ 0.01–1 psi) and AR(1) noise (ρ1 0–0.99);
quantisation (0.01–1 psi); sampling (1 s, 0.1 s); earth tides (M2 + K1, 0.05–0.5 psi); barometric (psig channels); surface conversion
with displacement warm-back (τ_T 0.5–5 h); vacuum truncation of the surface channel; leak (0.02–0.2 bbl/d); rate-clock offset (s to
1 h); psig written as psia; gauge depth used as datum; bbl/d written as bbl/min; water hammer (Γ, T, damping) in a high-rate window;
friction bleed-off (b, V_w·c_w); gauge thermal transient; early stop (0.5–3 t_c); shut-in valve on the gauge side (closed-line
signature); air in the well (V_w·c_w × 3).

**Truth** recorded per case: σ_c (mechanical, contact onset), σ_c,hyd (hydraulic), the model's F2-equivalent point (end of
stiffening, from the model's own compliance curve), ISIP, p_i, k, kh/μ, L, mechanism, regime at t_end (from t_DL), t_c, η, CL, Γ,
artefact list.

**Demo datasets** (`demo(name)`, deterministic seeds): `reference` (the §4.21 well, BH gauge, 1 s, with a step-down and a 50 Hz
shut-in window), `tight-linear` (example B), `conventional-radial` (example A), `contact` (hyp s_h 60), `pdl` (C_d 0.004),
`surface-gauge` (the reference with surface data, warm-back and a vacuum after 31 h). "Load demo DFIT" uses them; tests use them.

### 8.2 Benchmark design (`dfit-validate.js`; WP5 builds, WP8 runs in 3.4b)

| Set | Strata | Cases |
|---|---|---|
| Pre-closure | 8 mechanisms (normal, matrix, PDL, contact-hyp, contact-exp, storage, tip extension, height recession) × 3 storage levels (R_vis ≈ 0.95, 0.6, 0.3) × 3 noise levels (σ 0.05, 0.3, 1 psi with ρ1 0.9) × 2 shut-in lengths (1.5 t_c, 5 t_c) × 5 seeds | 720 |
| After-closure | k (1e-4 … 10 md, 6 levels) × geometry (full height, penny in a thick zone, box) × shut-in (linear only, transition, radial) × gas/liquid, 1 seed each with two noise levels | 120 (± a few cells pruned as physically empty) |
| Artefacts | 15 artefact kinds × 4 severities | 60 |
| **Total** | | **≈ 900** |

Run cost: one full ▶ Analyse per case ≈ 1–1.5 s desktop → ≈ 20 minutes for the whole set (tool only, never in acceptance).

**Acceptance subset** (`cases('acceptance')`, 12 cases, ≤ 20 s in `dfit-benchmark.test.js`): reference, contact, PDL, storage, matrix,
tip (gdomain), height recession (gdomain), example A, example B, penny, gas linear, surface gauge with vacuum.

### 8.3 What "right" means

| Output | Right when | Partial |
|---|---|---|
| Closure, single mode | \|consensus − σ_c\| ≤ max(25 psi, 0.5 % σ_c) | ≤ max(75 psi, 1.5 %) |
| Closure, range mode | the range [P10 of the lower family, P90 of the upper family] contains σ_c **and** the truth mechanism is concave-up (contact or height recession) | contains σ_c only |
| Closure, none | the truth closure is after the last data point, or within 0.3 G-decade of it | — |
| ISIP | within max(10 psi, 2 % pn) of the truth | within 5 % pn |
| Mechanism | top class = truth (with `hr-contact` counting for either) | truth in `alt` |
| p_i | truth inside the reported bracket and the point within the label's width | truth inside the bracket |
| k | truth inside [k_lo, k_hi] (bounds) or inside the 95 % CI (radial / match) | within × 2 |
| Regime label | equals the truth at t_end | adjacent regime |

**Caveat printed with every label statistic:** the truth closure is the mini-model's contact onset, which embeds the contact
physics, so the calibration favours F1 by construction. F2's agreement with its own model-equivalent point (end of stiffening) is
reported separately so the board's two families are both checked against their own definitions.

### 8.4 Label calibration (3.4b, WP8)

- Out-of-fold by seed (5 folds). For each label (high / medium / low) the hit rate = P(right | label) with a Wilson 95 % interval.
- Targets: high ≥ 0.90, medium ≥ 0.70 (lower bounds of the intervals ≥ 0.85 / 0.60). If a target is missed, WP8 tightens the rule
  thresholds marked "cal" in §4.22 (R_vis, band width, noise) by a grid search on the training folds and re-checks out of fold.
- Live CUSUM (k, h) tuned on replays of the benchmark so that false early "provisional" calls (before t_c) are ≤ 5 % and the median
  confirmation delay is ≤ 0.3 G-decade.
- `dfit-validate.js --write` writes `49-calc-dfit-cal.js` (generated header "GENERATED — never edit by hand"), with `calibrated:true`,
  `version`, `generator:'g1'`, `n`, `hitRate:{high:{p, lo, hi, n}, …}`, `cusum`, `thresholds`, the date and the app version. The board
  then shows e.g. "medium — 78 % right on 312 synthetic tests (73–83 %)".

### 8.5 `prism-build/dfit-validate.js`

`dfit-validate.js [--set pre|aca|art|all] [--seed n] [--folds 5] [--write] [--out <dir>] [--cases id,…]` builds the app from sources
(harness `loadApp({fromSources:true})`), runs each case through the same synchronous engines as ▶ Analyse, scores it with
`PRiSM_dfit_synth.score`, prints a confusion matrix per output and per label, writes `dfit-validate.json` and `.md` to `--out`
(scratch; never committed) and, with `--write`, the cal file. It exits 0 unless a target is missed with `--strict`.

### 8.6 What runs where

| Check | Where | Time |
|---|---|---|
| Verification vectors (G table, constants, V1–V12, examples A/B, related-test vectors) | acceptance (`dfit-*.test.js`) | ≈ 70 s total |
| 12-case benchmark subset | acceptance (`dfit-benchmark.test.js`) | ≤ 20 s |
| 900-case benchmark + calibration | `dfit-validate.js` (WP8, 3.4b) | ≈ 20 min |
| 20-seed replay false-call check | acceptance (`dfit-live.test.js`, V1) | ≤ 8 s |
| GUI sweep of DFIT mode | `gui-sweep.js --route prism` (report, not a gate) | part of the sweep |

---

## 9. Work packages

### 9.0 Dependencies, schedule, merge order

```
v3.3 merged ──► WP0 contracts (day 0) ──► WPH generic hooks + O(n) Bourdet ───────────────┐
                                    ├──► WP1 wellbore engine (48) ─────────────────────────┤
                                    ├──► WP2 pre-closure core (56) ────────────────────────┤
                                    ├──► WP3 after-closure + results layer (57) ───────────┼──► WP6 UI + integration ──► WP7 reviews + release v3.4
                                    ├──► WP4 leak-off model + designer (58) ───────────────┤      (builds on fixtures from day 1)
                                    └──► WP5 synth generator + validate tool (49 helpers) ─┘
3.4b (after v3.4 ships): WP8 calibration · WP9 live listeners · WP10 field tests (step-rate, flowback, MOC hammer, two-gauge)
                         · WP11 model extras (storage model, F_n, tip extension, multi-cycle, drag-to-fit) · WP12 lenses (stretch) · WP13 release v3.4.1
```

- WP1–WP6 run **in parallel** after WP0 (WPH as early as possible: WP6 needs its hooks for real UI tests; engine WPs do not).
- **Merge order (3.4a):** WPH → WP1 → WP2 → WP4 → WP3 → WP5 → WP6 (rebased on everything; adds `dfit-integration.test.js`) → WP7.
- **Estimates (engineer-days):** WP0 1, WPH 4, WP1 7, WP2 12, WP3 10, WP4 12, WP5 5, WP6 15, WP7 3 → **3.4a ≈ 69**. 3.4b: WP8 3,
  WP9 5, WP10 8, WP11 7, WP12 3 (stretch), WP13 2 → **3.4b ≈ 28**.
- **Critical path:** WP0 → WP2 → WP6 (final integration, ≈ 5 days after WP2/WP3 land) → WP7 ≈ 22 working days, with WP6 building
  against `tests/_dfit-shapes.js` fixtures from day 1.
- **Acceptance additions (3.4a):** 18 files, ≈ 160 tests, ≤ 150 s in total (pure-engine files share one app per file). The count
  goes from the v3.3 figure (≈ 1,037) to ≈ 1,197; the exact number is fixed at integration. 3.4b adds ≈ 25 tests (one new file).
  Smoke: + 8 checks (3.4a), + 2 (3.4b).

### WP0 — Contracts and skeleton (lead; serial; before everything)

- **Files:** `concat-round8.js` (FILES += 56–59, banner), `tests/_dfit-shapes.js`, `tests/dfit-shapes.test.js`, empty skeletons of
  56–59, `48-calc-wellbore.js`, `49-calc-dfit-synth.js`, `49-calc-dfit-cal.js` (placeholder `PRiSM_dfit_cal` of §3.9), this plan's
  status line.
- **Deliverables:** `checkShape` for every §3.13 name; `FIX.ds`, `FIX.state`, `FIX.aca`; skeleton files that load in the smoke stub
  and export the §3 names as stubs returning `{ok:false, code:'NOT_IMPLEMENTED'}`.
- **Tests:** `dfit-shapes.test.js` (1 test, ≤ 1 s): fixtures pass, a broken copy fails with a path.
- **Done when:** Dev builds; smoke unchanged + skeleton loads; existing Round-8 acceptance files pass; tag `v3.4-wp0`.

### WPH — Generic PRiSM hooks and the O(n) derivative

- **Files owned:** `01-foundation.js`, `02-plots.js`, `04-ui-wiring.js`, `05-regression.js` (one export), `07-data-enhancements.js`,
  `11-polish.js`, `33-pta-core.js`, `35-rta-dca.js`, `36-report.js`, `37-prism-workflow.js`, host job-report lines,
  `tests/dfit-hooks.test.js`.
- **May assume:** §3.12 only. No DFIT code.
- **Deliverables:** every row of §2.3 except 29-multiwell, smoke, gui-sweep and iOS CSS (WP6).
- **Tests** (`dfit-hooks.test.js`, 11 tests, ≤ 6 s): H1 O(n) Bourdet identical to the old loop (max relative difference ≤ 1e-12) on
  log-spaced, uniform and superposition-time sets, and 4,000 uniform points in < 5 ms; H2 window aliases exist; H3 `prism:plot-hover`
  fires with `opts.hoverEvent` and the pointer owner suppresses the box gesture; H4 `_defaultKinds` honours `entry.axes`; H5 a dummy
  `PRiSM_modeExt.test` appears in the select, relabels the steps, uses its step views, rail and status, and transient / decline /
  combined are unchanged (labels, plot lists, step hosts); H6 `PRiSM_undoExtras` round-trip and `'dfit'` in `STATE_FIELDS` survives a
  reload; H7 a section with `modes` and `plots` renders PNGs in the report HTML only in its mode, and `PRiSM_reportKeyLine` /
  `PRiSM_reportReady` follow the ext; H8 `PRiSM_rng(1)` reproduces the 05 bootstrap sequence; H9 a CSV with surface pressure, bbl/min
  rate and temperature reloads with all channels; H10 RTA linear flow takes k from `PRiSM_dfit_kConstraint` when no input or fit
  exists; H11 `PRiSM_toolCatalogueExtra` entries appear only in their modes, de-duplicated.
- **Done when:** H1–H11 pass; `wp6-plots`, `wp13-workflow`, `wp10-tools`, `platform-reports` and every Round-8 acceptance file are
  unchanged; C2 on 4,000 uniform falloff points < 60 ms.

### WP1 — Wellbore engine (`48-calc-wellbore.js`)

- **Files owned:** `48-calc-wellbore.js`, `tests/dfit-wellbore.test.js`.
- **May assume:** `PRiSM_pvt_correlations` (Round 3), `WTS_tubulars` (40), `WTS_flowline_friction` and `WTS_gradient_compute`
  (resolved at call time), `PRiSM_lm`, `PRiSM_rng`.
- **Deliverables (3.4a):** `column`, `tempProfile` (static, displaced), `hydrostatic`, `pipeFriction` (Newtonian, FR, power law),
  `perfFriction`, `nwbLoss`, `bleedOff`, `convert` (with band), `vacuum`, `stepDown`, `stepDownDesignCheck`, `hammerQuick`, `align`.
- **Tests** (`dfit-wellbore.test.js`, 18 tests, ≤ 5 s): W1 v = 17.157 ft/s for 1 bbl/min in 1 in; W2 perforation constant 0.2376
  (first principles) and 37.6 psi; W3 water in 5½-in casing at 5 bbl/min: Re 140,456, 40 psi smooth / 46 psi rough; W4 2⅞-in tubing
  1,020 / 1,355 psi; W5 power law 66 psi (laminar, casing) and 1,134 psi (turbulent, tubing); W6 n = 1 limits 926.6 and 1/(1,497.6 d²);
  W7 Virk f 0.00049 at Re 549,856; W8 8.43 ppg ⇔ 1.571 wt %; W9 p_s for BHP 7,600: 3,220.0 / 3,173.0 / 3,181.3 / 3,260.1 psia; W10
  warm-back +18.3 / +33.8 / +57.4 psi; W11 bleed-off 1 psi at 17.33 / 1.83 min; W12 step-down reference fit (p_frac 7,595.5, a 1.528,
  b 140.9, n 11.9); W13 se table (10.6, 0.414, 8.8) and refusal of the 25 % range; W14 n_p P10/P50/P90 8.9 / 11.7 / 16.0 (± 0.3,
  seeded); W15 surface tubing case → n_p "not determinable"; W16 hammer: c 4,539 ft/s, T 8.81 / 4.41 s, Joukowsky 232.1 psi, and a
  synthetic 50 Hz window gives ISIP_wh within 1 psi and the quarter-wave reflector within 3 %; W17 vacuum 195.2 / 95.9 / −3.3 psia;
  W18 clock offset 37.4 s within 0.2 s.
- **Done when:** W1–W18 pass; self-test present; loads in the smoke stub; no timers.

### WP2 — Pre-closure core (`56-prism-dfit-core.js`)

- **Files owned:** `56-prism-dfit-core.js`, `tests/dfit-gfunction.test.js`, `tests/dfit-preclosure.test.js`,
  `tests/dfit-closure.test.js`, `tests/dfit-triage.test.js`.
- **May assume:** §3.4 (WP1 functions resolved at call time, stubbed in tests until WP1 merges), `PRiSM_compute_bourdet` (WPH),
  `PRiSM_lm`, `PRiSM_rng`, `PRiSM_autoInterp.canon/hash16` (optional).
- **Deliverables:** every §3.5 function; §4.1, 4.3–4.11; the consensus Job; the triage and blunder library (§6.3); the fast chain.
- **Tests:** `dfit-gfunction` (8 tests, ≤ 2 s): G1 g0 = π/2, 4/3; G2 the G table (G(1, ½) 1.27324, G(1, 1) 1.40638, G(10, ½) 6.3159,
  G(100, ½) 23.5495, G(100, 1) 23.8307); G3 quadrature vs closed forms < 1e-5 at ΔtD 0, 0.1, 1, 10, 61.7; G4 g0(8/9, 4/5, 2/3) =
  1.37689 / 1.41495 / 1.47835; G5 G⁻¹(18, ½) = 61.019; G6 η(18, ½) 0.9000 and η(18.276, 1) 0.9150; G7 slopes 0.785 / 0.617 / 0.539;
  G8 the data-driven G equals the closed form for a constant-rate schedule within 1e-4 and stays monotone on a ramped two-cycle
  schedule. `dfit-preclosure` (17 tests, ≤ 8 s): P1 events on `FIX.ds` (t_s within 1 s; tp choices); P2 resampler: 10⁶
  samples in < 300 ms, 40 per decade; P3 reconciliation of the four reference candidates (7,605 / 7,600.0 / 7,595.5 / 7,599.4) → 7,600 ± 5 with label high; P4 the √t extrapolation reads 22–28 psi high on the same data
  (proves G is used); P5 Bourdet G·dP/dG equals the analytic m_G·G on Nolte data within 0.5 %; P6 D_ref; P7 geometry table (xf
  134.0 / 57.9 / 58.2 ft; CL 1.8634e-4 / 4.3147e-4 / 4.3774e-4; r_p 0.4286); P8 V_L during pumping 14.04 ft³; P9 q_L 0.500 / 0.0405
  bbl/min; P10 k from CL 2.64e-3 md; P11 forecast 2.46 / 8.63 h; P12 C_d 0.0040 ± 0.0002; P13 κ_exp −0.19 and the matrix
  classification; P14 R_vis 0.977 / 0.54; P15–P17 classifier on `PRiSM_dfit_vcModel` signatures (normal, matrix, PDL, contact /
  height recession, tip extension, storage; top class or alt correct; mini-model signatures are checked later in `dfit-benchmark`). `dfit-closure` (10 tests, ≤ 10 s): C1–C10 of §6.2. `dfit-triage` (8 tests, ≤ 5 s): T1–T8 of §6.3.
- **Done when:** all pass; the stability grid ≤ 600 ms on 2,000 points; no `Math.random`; every output passes `checkShape`.

### WP3 — After-closure and results layer (`57-prism-dfit-aca.js`)

- **Files owned:** `57-prism-dfit-aca.js`, `tests/dfit-aca.test.js`, `tests/dfit-uncertainty.test.js`, `tests/dfit-live.test.js`
  (V1–V4), `tests/dfit-report.test.js`.
- **May assume:** §3.5 outputs (fixtures until WP2 merges); examples A and B are built inline in the test file from the closed-form
  Carter-source convolution (WP5 re-implements it independently and S5 checks the two agree); `PRiSM_mpTable`, `PRiSM_gasPseudoTime`, `PRiSM_tideAnalysis`,
  `PRiSM_applyTideCorrection`, `PRiSM_MODELS[key].pdPrime`, `PRiSM_lm`, `PRiSM_rng`.
- **Deliverables:** every §3.6 function in 3.4a scope; §4.12–4.13; §6.4 (leak plot), §6.6, §6.8, §6.9 engine + replay, §6.10 engine.
- **Tests:** `dfit-aca` (16 tests, ≤ 12 s): A1 constants (250,856 ± 0.1 %, 4,181, 1,694.5, 97.54, 29,437, 845.50 / 109.15,
  1.1827e-3, 2.63679e-4); A2 Nolte vs impulse radial within 0.1 % late, and V = 8·CL_p·h·L·√t_c; A3 uniform-flux slope −0.950 at
  t_DL 1.60, −0.980 at 4.10 (± 0.002), penny −1.00 at ηt/R² 0.199; A4 F_R/F_Rc 0.9538 at 2 t_c, F_L(2t_c) = 0.5; A5 example A (F_R
  100–300 h: p_r 4,500.02 ± 0.05, kh/μ 50.5 ± 0.3; 20–300 h 51.97, bias upper; bracket contains 4,500 for t ≥ 1.2 t_c); A6 example B
  (F_L 5–30 h: p_r 4,500.00 ± 0.05, k 0.0100 ± 1 %; centroid impulse 10–55 h k within 2 %; F_R line > 4,500 on 3–10 h; F_L line < 4,500
  on 20–300 h); A7 trend bounds 0.653 / 0.854 md·ft/cp and the interval containing 0.01 md; A8 origin table ± 0.005; A9 gas: p_i
  converges in ≤ 3 passes and late radial kh/μ_i changes < 2 % at 5,000 psi; A10–A12 (§6.8); A13–A15 (§6.4); A16 p_i labels high on
  example A and medium on example B at 300 h. `dfit-uncertainty` (5 tests, ≤ 3 s): U1–U5 of §6.6. `dfit-live` (4 tests, ≤ 8 s):
  V1–V4 of §6.9. `dfit-report` (6 tests, ≤ 4 s): R1–R4 of §6.10; R5 frac sheet rows and CSV columns; R6 hand-off packet with a
  low-confidence p_i lists it as a blocker.
- **Done when:** all pass; `PRiSM_dfit_aca` ≤ 150 ms on 2,000 points; library match ≤ 800 ms.

### WP4 — Leak-off mini-model and designer (`58-prism-dfit-leakoff.js`)

- **Files owned:** `58-prism-dfit-leakoff.js`, `tests/dfit-leakoff.test.js`, `tests/dfit-leakfit.test.js`,
  `tests/dfit-designer.test.js`.
- **May assume:** `PRiSM_dfit_g/G/gFromHistory` (56, resolved at call time), `PRiSM_lm`, `PRiSM_jacobianForward`, `PRiSM_invertMatrix`,
  `PRiSM_rng`, `WTS_wellbore` (call time).
- **Gate G4 (before the tests are frozen):** verify the KGD (0.6152) and radial (0.6955) zero-toughness similarity coefficients against
  the original papers (Spence & Sharp 1985 / Adachi & Detournay 2002; Savitski & Detournay 2002). If not verifiable within WP4, ship
  the lumped laws with κ as derived from the coefficients in hand, label KGD/radial pumping pressures "viscous term uncalibrated" and
  keep V3 testing the model's own laws (it does by construction).
- **Deliverables:** §3.7 in 3.4a scope (no tip extension, no multi-cycle, no drag); §5; §6.1 (minus drag); §6.5; §6.7 engine; leak
  budget.
- **Tests:** `dfit-leakoff` (16 tests, ≤ 8 s): L1–L16 (§6.1). `dfit-leakfit` (8 tests, ≤ 12 s): F1 run A recovery inside the 95 % CI
  in ≤ 40 runs; F2 Γ conserved to 1e-3 (14.904); F3 run J (h_f wrong, E′ fixed) reports rmse ≈ 19.6 psi, σ_c bias ≈ −78 psi and fires the
  geometry warning; F4–F6 (§6.7); F7 n_eff inflation ≈ × 4.4 for AR(1) residuals with ρ1 0.9; F8 the structural spread contains the
  truth σ_c on the contact case. `dfit-designer` (5 tests, ≤ 6 s): D1–D5 (§6.5).
- **Done when:** all pass; simulate ≤ 50 ms at N ≈ 1,840; 5-parameter fit ≤ 1 s; Job = sync results.

### WP5 — Synthetic generator, demos and validation tool

- **Files owned:** `49-calc-dfit-synth.js`, `49-calc-dfit-cal.js` (placeholder), `prism-build/dfit-validate.js`,
  `tests/dfit-synth.test.js`, `tests/dfit-benchmark.test.js`.
- **May assume:** §3.7 `lkSimulate` (fixtures until WP4 merges) and the §4.12 kernels (own implementation for the `aca-exact` source,
  independent of 57, so the ACA tests check 57 against a separate calculation).
- **Deliverables:** §8.1–8.2, §8.5; the six demo datasets; the 12-case acceptance subset.
- **Tests:** `dfit-synth` (6 tests, ≤ 4 s): S1 determinism by seed; S2 demos pass `checkShape('DfitDataset')`; S3 each artefact injector
  changes only its target channel; S4 truth fields complete; S5 `aca-exact` reproduces the example A/B tables (Δp and D) within 0.1 %;
  S6 no `Math.random` in any DFIT source file (grep). `dfit-benchmark` (3 tests, ≤ 20 s): B1 closure right or partial on ≥ 11 of 12
  (right on ≥ 9); B2 mechanism right or partial on ≥ 10 of 12; B3 p_i inside the bracket on every ACA case.
- **Done when:** all pass; `dfit-validate.js --set art --cases …` runs end to end and writes its report to a scratch folder.

### WP6 — UI and integration (`59-prism-dfit-ui.js`)

- **Files owned:** `59-prism-dfit-ui.js`, `29-multiwell.js` (DFIT rows), `smoke-test.js` (DFIT list), `gui-sweep.js` (DFIT views),
  `ios-app/ios-additions/ios-styles.css` (DFIT block), `tests/dfit-ui.test.js`, `tests/dfit-integration.test.js`.
- **May assume:** every §3 interface and the fixtures; WPH hooks.
- **Deliverables:** §2.6–2.11, §7, `WTS_state.dfit`, the Analyse orchestration (§4.20), the replay tool, the report section rendering.
- **Tests:** `dfit-ui` (14 tests, ≤ 15 s): U1 the select option and `setMode('dfit')` relabel the steps; U2 transient / decline
  unchanged; U3 `onEnter` writes falloff + `multiRate` and is undoable; U4 each DFIT plot draws on the reference demo with `_prismAxes`;
  U5 `dfit-picks` hook registered once; U6 `dfitTangent` click stores a pick, logs it and undo restores it; U7 a drag through the
  pointer owner commits one log entry; U8 ▶ Analyse runs every stage with progress, and Cancel keeps the previous results; U9 zero
  pending timers after Analyse and `flush(5000)`; U10 DFIT panels mount only in DFIT mode; U11 390 px layout has no horizontal overflow;
  U12 the iOS CSS block exists; U13 every DFIT numeric input clamps blank / 0 / −1 / 1e12 without NaN text; U14 DFIT Tools entries only
  in DFIT mode. `dfit-integration` (10 tests, ≤ 15 s): I1 reference demo end to end (ISIP 7,600 ± 5, closure 7,000 ± 25, η 0.900 ±
  0.005, xf 134 ± 3 ft); I2 surface-gauge demo (band, vacuum masking after 31 h, closure within 30 psi of the BH result); I3 PTA
  hand-off (§6.8); I4 RTA k fallback; I5 the Tab-7 report and the PDF HTML contain the DFIT plots and the key line; I6 reload and
  project save/open restore `st.dfit` and `wts_prism_dfit_hf`; I7 two wells keep separate DFIT states and the comparison rows show both;
  I8 header Quick Report in DFIT mode; I9 no pending timers 5 s after opening DFIT mode; I10 DFIT → transient → DFIT keeps the picks.
- **Smoke additions (8):** the DFIT API list (all §3.5–3.8 names) is present; `PRiSM_modeExt.dfit` has `label`, `steps`, `analyse`,
  `rail`; plot keys `dfitG`, `dfitSqrt`, `dfitLogLog`, `dfitStrip`, `dfitAcaLogLog` registered with `mode:'dfit'` and a function `fn`;
  `dfit-picks` post-draw hook exactly once; the DFIT report section carries `modes:['dfit']`; G spot check (1.27324, 1.40638);
  `WTS_wellbore` shape; no pending timers with DFIT mode open.
- **Done when:** all pass; the GUI sweep of DFIT mode reports no NaN / undefined / Infinity / null / [object Object] and no error-level
  findings; `ux-layout-check` unchanged (no sidebar change).

### WP7 — Reviews and release v3.4

- Neutral-wording review of every DFIT string, help text, test name and comment (no product, vendor, company or website names; no
  doctrine attributed to a person; SPE numbers marked "no. to verify" absent from the app); engineering review of the verdict strings
  and labels; release items of §10; perf baseline re-record in its own commit; merge Dev → master after the batch is verified.

### 3.4b work packages (v3.4.1)

- **WP8 — Calibration** (3 d; files `49-calc-dfit-cal.js` (generated), `tests/dfit-cal.test.js`): run `dfit-validate.js --set all
  --write`; meet the §8.4 targets or tighten the "cal" thresholds; the board shows hit rates. Test: the cal file shape, `calibrated:true`,
  and the label text with the rate.
- **WP9 — Live listeners** (5 d; 59): §6.9 listeners, tag picker, tap-to-log, corridor display, 390 px live layout; V5–V6.
- **WP10 — Field tests** (8 d; 48 + 59 tools + `tests/dfit-fieldtests.test.js`): `stepRate` (hinge, superposition, Hall; vectors of
  §4.15), `flowback` / `pulses` (§4.16 vectors), `mocSim` / `hammerFit` (regime rows, first-swing ratios 0.040 … 1.905, critical
  amplitudes, capacitive periods 8.738 / 8.517 / 8.140 s), `calibrateTwoGauge`, Ramey profile (5,000 bbl/d, 30 d → 94.4 °F), `injector`
  and MASIP (2,162 / 2,265 psia).
- **WP11 — Model extras** (7 d; 57, 58): variable-storage ACA model (reproduces example B within 0.5 psi with C_res = 0 and a Carter
  source), generalised F_n, tip extension and multi-cycle in the mini-model, drag-to-fit, step-down hysteresis and per-step hammer.
- **WP12 — Interpretation lenses** (3 d, stretch; 57 + 59): §6.11.
- **WP13 — Release v3.4.1** (2 d).

### Out-of-module follow-ups (other workstreams; not in v3.4)

- The live-data page's "Send to PRiSM" (route `wellos`, `63-wellos.js:570`) sends psig without conversion for PTA too: convert to
  psia at the PRiSM boundary for every mode (DFIT already converts).
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
   ['prism','DFIT workspace','Choose “DFIT (fracture injection)” in PRiSM: data and events, ISIP and friction, pre-closure, after-closure and model, report — with G-function, √t and log-log plots and every closure method.'],
   ['new','Closure consensus','All closure methods on one strip, grouped into families, giving one closure or a closure range with a confidence label, the reasons, a frictional-limit check and a logged override.'],
   ['new','Test triage','Data-health checks within seconds of import: vacuum, air in the well, thermal effects, gauge resolution, clock alignment, unit and depth blunders, and an early re-pump verdict.'],
   ['new','After-closure analysis','Reservoir pressure with a bracket that needs no guess, transmissibility or bounds on permeability when radial flow is not reached, gas in adjusted variables, a leak check, and matching with the PRiSM model library.'],
   ['new','Leak-off model','“What leak-off rate do I get?” with no data, and history matching of a recorded DFIT that states which parameters the test actually determines.'],
   ['new','DFIT designer','Ranges in; shut-in length, volume, gauge and sampling, vacuum check, checklist and the expected outcome out.'],
   ['new','Uncertainty','P10/P50/P90 on every DFIT number with the share of each input, a tornado and a what-if closure marker.'],
   ['report','DFIT report','Evidence references on every number, a pick and override log, data + picks export and a frac-design sheet; PTA and RTA hand-off in one click.'],
   ['ux','Faster derivatives','The pressure derivative is now computed in linear time: long falloffs redraw in milliseconds.'] ] }
```

  3.4b (`v3.4.1`): live DFIT co-pilot on the Modbus station and historian; step-rate test; flowback and pulse analysis; water-hammer
  model fit; calibrated confidence labels; storage-model after-closure fit. Engineering changes only; `&amp;` in the HTML; no research,
  competitor or paywall wording.
- **Version** 3.4 (then 3.4.1): `MARKETING_VERSION` at both places in `project.pbxproj`; `VERSION_BASE` in both copies of
  `ci_post_clone.sh` (identical); `tests/ios-native.test.js` and `app-version.test.js` follow `RELEASE_NOTES[0].ver`.
- **README:** a DFIT paragraph (generic wording); counts (models unchanged at 46, smoke, acceptance).
- **CLAUDE.md:** file-map lines for 56–59, `48-calc-wellbore.js`, `49-calc-dfit-synth.js`, `49-calc-dfit-cal.js` ("GENERATED — never edit
  by hand") and `dfit-validate.js`; the Round-8 build note (FILES now include 53–59); the generic hooks (`PRiSM_modeExt`,
  `PRiSM_undoExtras`, `PRiSM_toolCatalogueExtra`, report `plots`/`modes`, `prism:plot-hover`, pointer owner, `PRiSM_rng`,
  `PRiSM_reportKeyLine`/`Ready`); C1 provenance `dfit`; C7 events `prism:dfit-updated`, `prism:dfit-model-updated`; C8 `dfit` in
  `STATE_FIELDS`; shared engines list + `WTS_wellbore`; the O(n) derivative note; stats; "Latest release: v3.4".
- **PROJECT-NOTES:** v3.4 entry (scope, benchmarks, known limitations).
- **perf-baseline.json:** DFIT adds ≈ 8–11k source lines (≈ 0.45–0.6 MB); re-recorded in a separate commit.

---

## 11. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Users read the consensus as "the truth" in an open dispute | Misplaced confidence | Range shown by default when families disagree; both readings with all downstream numbers; labels say "uncalibrated" until 3.4b and state the truth-model bias after |
| Priors drive the forward tools (designer, corridor, forecast, uncertainty) | Confident-looking nonsense | Priors and their provenance printed next to every band; "generic priors in use" banner; modest defaults |
| Lumped mini-model over-trusted | Wrong CL / E′ / geometry | Γ shown as primary; inflated and structural intervals; validity diagnostics; "apparent toughness is not a rock property" |
| Unverified constants (KGD/radial similarity) and SPE numbers | Wrong pumping-pressure level; wrong citations | Gate G4; "uncalibrated" label; "no. to verify" numbers never in the app |
| Hooks regress transient / decline mode | PTA breakage | WPH test H5 + all existing acceptance; ext code paths only when `PRiSM_modeExt[mode]` exists |
| O(n) Bourdet differs subtly | Changed PTA derivatives | H1 identity test on three data shapes; fallback to the old loop when `lnx` is not monotone |
| v3.3 slips or `PRiSM_autoInterp.drive` / `canon` change | No async driver, no hashes | v3.4 is sequenced after v3.3; fallback: synchronous jobs with a progress message, hashes `null` |
| Phone performance (stability grid, fits, designer) | Sluggish UI | Jobs with progress and Cancel; coarse grids; 1,000-draw default |
| 1 s data over days (10⁵–10⁶ rows) | Slow import, storage quota | Gauge manager path; O(n) resampler; HF windows capped at 600 kB |
| Surface-gauge DFITs | Biased BHP, vacuum | Conversion band, warm-back model, vacuum masking, triage fails stated |
| Live false early closure calls (3.4b) | Gauge pulled too early | Provisional → confirmed; CUSUM calibrated on replays; verdict advisory |
| Bundle growth | perf-budget flag | Re-record the baseline; no new libraries |
| Confidentiality of wording | Names in strings or docs | WP7 neutral-wording review; generic descriptions only |

---

## 12. Open questions (each with the default we use; we do not stop to ask)

| # | Question | Default |
|---|---|---|
| Q1 | Name of the mode in the header select | "DFIT (fracture injection)"; crumb "PRiSM · DFIT" |
| Q2 | 3.4a / 3.4b split | As §1.5 and §9: analysis, model, designer, replay in 3.4a; live listeners, field tests, calibration, extras in 3.4b |
| Q3 | Default α | `auto`: data-driven G when a rate history exists, else α = ½; α = 1 shown as the bound when ΔtD,c < 5 |
| Q4 | Standalone Round-9 leak-off page | Not in v3.4 (the sandbox runs in PRiSM with no data; Production & Reservoir is at 7 of 8 rows). Revisit with a "Fracture tests" hub |
| Q5 | Standalone step-rate page for injector engineers | Not in v3.4; Tools entry in DFIT mode (3.4b) |
| Q6 | Which closure feeds hand-offs when the board shows a range | None automatically: the PTA hand-off and the frac sheet ask the user to choose an end (the sheet carries both ends by default); the choice is logged |
| Q7 | Default ISIP when families disagree (low label) | The falloff-family (G extrapolation) value when its residual test passes, else the inverse-variance consensus; flagged |
| Q8 | Default tp | Pump start; the sensitivity of G_c and η to the other two is always shown |
| Q9 | Default reservoir fraction w_c | 1 for water / slickwater, 0 for gel and other wall-building fluids |
| Q10 | E′ missing | Geometry outputs hidden; Γ, η, pn, closure and ACA still reported; "enter E′ for geometry" ⚠ |
| Q11 | Frictional limit defaults | μ = 0.6, S_v gradient 1.0 psi/ft, editable; the veto can be overridden with a reason |
| Q12 | Empirical closure-time permeability correlation | Not shipped |
| Q13 | SPE numbers marked "no. to verify" | Never shown in the app; author, year and title only until verified |
| Q14 | Does DFIT write p_i into C1 automatically? | No; only through the PTA hand-off, after confirmation, and only with a label ≥ medium unless the user includes it |
| Q15 | Does DFIT add a `PRiSM_MODELS` entry? | No; model count stays 46 |
| Q16 | Tide removal | Automatic when the after-closure window spans ≥ 24 h and the tidal amplitude exceeds 10 % of Δp |
| Q17 | PTA report sections in DFIT mode | Hidden (`reportLegacySections:false`) |
| Q18 | Analyst name in the pick log | Free text from the report options, empty by default; the log is integrity aid, not a signature |
| Q19 | High-rate windows | Up to 3 windows × 12,000 samples, ≤ 600 kB, in `wts_prism_dfit_hf` |
| Q20 | Live pressure units (3.4b) | Station canonical psig → psia with `atmPsia` |
| Q21 | Re-pump verdict wording | Advisory; needs "Acknowledge"; never blocks analysis |
| Q22 | Uncertainty sample size | 1,000 (2,000 selectable) |
| Q23 | Leak tolerance ε | 0.05 |
| Q24 | Import above 200,000 rows | Through the gauge manager, then "Use for DFIT" |
| Q25 | Without v3.3's driver | Jobs run synchronously with a progress message; no timers |

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
- Mayerhofer, M.J. et al. 1995. Pressure-transient analysis of fracture-calibration tests. SPE 26527 (author list to verify).
- Nolte, K.G. 1979. Determination of fracture parameters from fracturing pressure decline. SPE 8341.
- Nolte, K.G. 1986. A general analysis of fracturing pressure decline with application to three models. SPE 12941.
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
  critical review of DFIT and analysis gone wrong (no. to verify).

---

## Appendix A. Where the acceptance vectors live

| Topic | Section | Test file |
|---|---|---|
| G table, quadrature, inverse, η, slopes | §4.5, §4.9 | `dfit-gfunction` |
| Reference well: ISIP, closure, geometry, CL, leak-off rate, k, forecast, R_vis | §4.21 | `dfit-preclosure`, `dfit-integration` |
| Toy contact, consensus, veto, counterfactual | §4.7, §6.2 | `dfit-closure` |
| Conversion, friction, perforations, bleed-off, step-down, hammer, vacuum, alignment | §4.2, §4.14, §4.17 | `dfit-wellbore` |
| After-closure constants, examples A and B, bounds, origin table, gas, transform, leak | §4.12–4.13, §6.4, §6.8 | `dfit-aca` |
| Mini-model V1–V12, quick table, goal-seek | §5.4, §6.1 | `dfit-leakoff` |
| History match, groups, Fisher, extension table | §5.7, §6.7 | `dfit-leakfit` |
| Designer reference cases, V_min, vacuum | §6.5 | `dfit-designer` |
| Uncertainty | §6.6 | `dfit-uncertainty` |
| Replay, CUSUM | §6.9 | `dfit-live` |
| Evidence, quoted check, export, frac sheet, hand-off | §6.10, §6.8 | `dfit-report`, `dfit-integration` |
| Step-rate, flowback, MOC hammer, two-gauge, Ramey, MASIP (3.4b) | §4.15–4.17 | `dfit-fieldtests` |

## Appendix B. Corrections and open checks carried over from the research notes

1. **Water-hammer table, Γ > 0 rows.** For a closed-end (half-wave, staircase) termination the decay per 2L/c period is Γ, not Γ²: 0.60
   (R = 2,000) and 0.91 (R = 10,000) instead of 0.36 and 0.82. The Γ < 0 rows (Γ² per 4L/c period) were right. §4.17 uses the corrected
   rule (verified by the method-of-characteristics simulation).
2. **Reservoir-controlled leak-off lower bound on k.** The bound k ≥ μ/(φc_t)·(CL_p/(1.1827e-3·Δp))² decreases with Δp, so a bound that
   is safe for the true Δp must use the **largest** plausible Δp (p̄_frac high, p_i at the **lower** bracket edge) and the lowest CL_p;
   the after-closure note's "use the p_i upper bracket" gives a larger, non-conservative k_lo. §4.12 uses the corrected form.
3. **Leak-corrected p_i window bias.** The prototype's corrected p_i reads ≈ 7.5 psi high even with no leak (transitional data in the
   window); the UI states the bias next to the corrected value.
4. **G(1, α = 1)** = 1.40638 (re-computed; one note rounded it to 1.40640).
5. **KGD and radial zero-toughness similarity coefficients** (0.6152, 0.6955): unverified, gate G4 (§9, WP4).
6. **SPE numbers to verify** before any help text: Craig 2014; Benelkadi & Tiab 2004; Settari 1985; Wang & Sharma 2017 (the notes give
   two different titles); Mayerhofer et al. 1995 (the notes give two different author lists); Hawkes et al. 2018. A water-hammer paper
   quoted in the landscape note with an approximate number is not used.
7. **Leak-plot detection floor** (0.021 bbl/d with no leak in the prototype) is data-dependent: the floor is computed from the
   regression's own noise, not hard-coded.
8. **Psig detection** cannot rely on the gradient priors alone (14.7 psi moves a 10,000 ft ISIP gradient by 0.0015 psi/ft); the blunder
   test uses the source unit flag and a channel reading within ±2 psi of zero while the well is open to atmosphere.
