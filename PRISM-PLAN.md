# PRiSM — Advanced Well Test Analysis (Plan)

> Planning document for an advanced Well Test Analysis module that
> ABSORBS the existing PTA Quick Look + DCA Quick Run modules.
> Nothing here is implemented yet — edit before execution.

## ⚙️ Decisions locked (2026-04-25)

| Question | Decision |
|---|---|
| Name | **PRiSM** _(Pressure Reservoir inversion & Simulation Model)_ |
| Sidebar placement | Inside `Production & Reservoir`, displayed as `PRiSM` |
| Existing PTA + DCA modules | **Roll both into PRiSM** — retired as standalone, capabilities absorbed |
| Phasing | **Ship Phase 1 + 2 as one release** (~90% of routine work covered) |
| iOS | **Yes, full module on iOS too** |

---

## 1. Name proposals

Pick one. My ranked suggestions:

- **PRiSM** — _Pressure Reservoir inversion & Simulation Model_. Every
  letter unpacks meaningfully; plays on the optical metaphor of
  decomposing raw pressure data into reservoir parameters, the same
  way a glass prism decomposes white light into a spectrum.
  Distinctive, technical, memorable. **My primary recommendation.**
- **Stratum** — single-word, evokes reservoir layers / geology.
- **Reservoir Lens** — descriptive, what the tool does.
- **WaveShaper** — pressure transient = wave; tool shapes/fits it.
- **Cascade WTA** — flow cascades through well/reservoir/boundary.

---

## 2. Where it sits in the suite

- Stays inside the existing **`Production & Reservoir`** sidebar
  group. Group becomes:
  - Oil & Gas Rate
  - Solution GOR
  - **PRiSM** (replaces both DCA and PTA entries)
- **DCA Quick Run** (current `dca` route) and **PTA Quick Look**
  (current `pta` route) are RETIRED as standalone modules. Their
  models and plots become PRiSM's `Decline` and `Transient` modes.
- **Back-compat redirects**: `dca` and `pta` routes both forward to
  `prism` so existing bookmarks / shared deeplinks keep working.
  Toast pops on first visit to either: _"DCA / PTA is now part of
  PRiSM."_
- **Data migration**: existing `wts_dca` and `wts_pta` localStorage
  keys are read once on first PRiSM open and migrated into the new
  `wts_prism` namespace. Old keys retained for one release as
  fallback, then dropped.

---

## 3. Workflow — analysis mode toggle + 7 tabs

A top-bar **Analysis Mode selector** drives which model library and
plots are visible. PRiSM unifies the two analysis paradigms that
were separate modules (PTA + DCA) into one workflow:

```
Mode:  ( Transient PTA | Decline DCA | Combined )

[1 Data] → [2 Plots] → [3 Model] → [4 Params] → [5 Match] → [6 Regress] → [7 Report]
```

- **Transient PTA** — short-time pressure-rate behaviour. Plots and
  models are the type-curve set inherited from the old PTA module
  plus the new advanced library.
- **Decline DCA** — long-time rate-time behaviour. Plots and models
  are the Arps / Duong / Stretched-Exponential set inherited from
  the old DCA module plus type-curve regression.
- **Combined** — early-time period fits to a transient model
  (constrains kh, S, boundary distance), late-time period fits to a
  decline model (constrains EUR, b-factor). Both fits share the same
  PVT inputs and well info — single source of truth for the well.

### 3.1 Data Import & Cleanup

- Paste from Excel, upload CSV, or hand-type
- Multi-column: time, pressure, rate (allows multi-rate histories
  with shut-ins)
- Graphical despike: drag a rectangle around outliers → drop
- Downsample large datasets (visual decimate keeping inflection points)
- Reference-time alignment + rate-history editor

### 3.2 Plot Workshop — diagnostic suite

**Transient mode** plots:

| Plot | Purpose |
|---|---|
| Cartesian P vs t | First-look, period boundaries |
| Semi-log Horner | Radial flow `kh` from slope |
| **Log-log Bourdet derivative** | Keystone diagnostic — flow regimes from derivative shape |
| Square-root time | Linear flow (channels, fracture half-length) |
| 1/4-root time | Bi-linear flow (finite-conductivity fracture) |
| Spherical-flow | Partial penetration |
| Sandface-rate convolution | Wellbore-storage-distorted multi-rate cleanup |
| Build-up superposition | Multi-rate interpretation |

**Decline mode** plots (inherited + extended from old DCA module):

| Plot | Purpose |
|---|---|
| Cartesian rate vs time | Visual decline pattern |
| Semi-log rate vs time | Exponential decline = straight line |
| Log-log rate vs time | Hyperbolic / harmonic curvature |
| Rate-cumulative (q vs Np) | Reserves estimate, OOIP intercept |
| Loss-ratio plot (1/D vs t) | Identify decline mechanism |
| **Type-curve overlay** | Match rate-time data to Arps / Duong / SEPD type curve |

**Combined mode** stacks both — early-time on transient axes,
late-time on decline axes, with shared period selector.

All canvas-rendered, zoomable, multi-period overlay so build-ups
can be compared side by side.

### 3.3 Model Library — categorised picker

- **Well type**
  - Vertical
  - Horizontal
  - Inclined
  - Partial penetration
  - Hydraulic fracture (∞-cond)
  - Hydraulic fracture (finite-cond)

- **Reservoir**
  - Homogeneous
  - Dual-porosity (PSS)
  - Dual-porosity (transient)
  - Radial composite
  - Linear composite (up to 5 zones)
  - Multi-layer (with cross-flow)
  - Multi-layer (without cross-flow / commingled)

- **Boundary**
  - Infinite-acting
  - Single fault
  - Parallel channel
  - Closed channel (3-sided)
  - Closed rectangle
  - Constant-pressure
  - Intersecting faults
  - Leaky / partially sealing fault

- **Fluid**
  - Oil (single phase)
  - Dry gas
  - Gas-condensate (pseudo-pressure)
  - Water injection (two-phase Buckley-Leverett solution)

Each model card has: schematic SVG, parameter list, applicable
diagnostic plots, references (Bourdet-Gringarten, Cinco-Ley-Samaniego,
Warren-Root, Ozkan-Raghavan, etc.).

### 3.4 Parameter Setup

- **Reservoir**: kh, k, h, φ, c_t, μ, B
- **Well**: r_w, S, C_s, completion length (horizontal)
- **Fracture**: x_f, F_cD
- **Composite**: r_inner, M (mobility ratio), F (storativity ratio)
- **Dual-porosity**: ω, λ
- **Boundaries**: distance to each, transmissibility ratio
- Each parameter: initial value, lower / upper bounds,
  **fix or float** for regression

### 3.5 Type-Curve Match — forward simulation

- Compute model pressure response in real time
- Overlay on the diagnostic plots
- Drag-to-fit: hold a parameter, drag, model recomputes
- Eyeball-match before going to regression

### 3.6 Non-Linear Regression — the heavy hitter

- **Levenberg-Marquardt** (with Marquardt-factor adapt)
- User picks which params float / which stay fixed
- Bounds enforced
- Iteration log shown live
- **Confidence intervals**: Jacobian-based at convergence,
  bootstrap optional
- Goodness-of-fit: RMSE, R², AIC for cross-model comparison

### 3.7 Results & Report

- Summary table: model name, all parameters with units + uncertainty
- Re-rendered diagnostic plot panel for export
- **Export PDF** through existing `exportReport` pipeline (gets the
  cover page + client info)
- Export fit data as CSV for handover

---

## 4. Technical implementation notes

### 4.1 Forward solutions (Laplace + Stehfest inversion)

| Solution | Source / reference |
|---|---|
| Vertical well infinite-acting | Theis line source |
| Wellbore storage + skin | Agarwal-Ramey, Bourdet-Gringarten |
| Hydraulic fracture (∞-cond) | Gringarten-Ramey-Raghavan |
| Hydraulic fracture (finite-cond) | Cinco-Ley-Samaniego |
| Horizontal well | Goode-Thambynayagam, Ozkan-Raghavan |
| Dual-porosity | Warren-Root, with PSS / transient λ |
| Radial composite | Olarewaju-Lee |
| Boundaries | Image-well superposition |

All in pure vanilla JS using `Math.*`. Stehfest coefficients are a
fixed table of `N=12` weights, ~50 lines. Each model evaluator is
30–80 lines. Total model library ≈ 1500–2000 lines.

### 4.2 Code organisation (proposed file split, all stays inside `well-testing-app.html`)

```text
// PRiSM ─ Advanced Well Test Analysis
PRiSM_MODELS    // type-curve evaluators       ~2000 lines
PRiSM_SOLVERS   // Stehfest, Levenberg-Marquardt ~400 lines
PRiSM_PLOTS     // canvas plotters              ~600 lines
PRiSM_DATA      // import/cleanup               ~400 lines
renderPRiSM()   // tabbed UI shell              ~500 lines
```

≈ **4000 LOC added**. For context, the entire current app is
~7700 lines of JS, so this would grow the suite by ~50%.

---

## 5. Phasing — ship in 5 increments

| Phase | Deliverable | Status |
|---|---|---|
| **1** | Data import, Cartesian + Horner + log-log Bourdet plots; single model (vertical well + WBS + skin, infinite-acting); manual parameter input; visual match | ✅ shipped 2026-04-25 |
| **2** | + Boundaries (single fault, parallel channel, closed rect) via image wells; + hydraulic fracture (∞ + finite cond); + horizontal well | ✅ shipped 2026-04-25 |
| **3** | + Levenberg-Marquardt auto-match with bounds + confidence intervals + AIC; multi-rate superposition; sandface-rate convolution; Arps + Duong + SEPD + Fetkovich decline | ✅ shipped 2026-04-26 |
| **4** | + Dual-porosity (3 modes); partial-penetration; vertical pulse-test; multi-format Data-tab parser + filters + column-mapper | ✅ shipped 2026-04-26 |
| **5** | + Composite (radial + linear); multi-layer with cross-flow; gas-condensate pseudo-pressure; water-injection two-phase | pending (post-launch decision point) |

**Phase 1 alone is already much more capable than the current PTA
Quick Look** — and gives the framework to layer the rest in over
time without breaking the user experience.

---

## 6. Scope honesty

This proposal is roughly 5–10× the LOC of the existing PTA module.
Worth being explicit:

- **Real well-test engineers using dedicated apps** (Saphir, F.A.S.T.,
  KAPPA Workstation) have decades of model validation behind them.
  Matching parity is unrealistic.
- **Our angle**: _"good-enough quick-look that runs offline in any
  browser, no licence."_ PRiSM Phase 1 + 2 hits that target.
  Phases 3–5 push toward overlap with paid tools.
- **Recommendation**: ship Phase 1 + 2 fully tested before deciding
  whether 3–5 are worth the maintenance burden. Most users won't need
  Levenberg-Marquardt regression — visual matching covers the common
  cases.

---

## 7. Open questions before execution

- [ ] **Name** — PRiSM, Stratum, Reservoir Lens, WaveShaper, or Cascade?
- [ ] **Sidebar placement** — new `Advanced Analysis` group, or just
      add to existing `Production & Reservoir`?
- [ ] **Existing PTA module** — rename to `PTA Quick Look` or retire
      and roll into PRiSM?
- [ ] **Phasing** — ship Phase 1 standalone (functional but limited
      model library), or wait for Phase 2 (covers ~90% of routine
      work)?
- [ ] **iOS** — full PRiSM on iOS too, or web-only? Heavy compute
      might tax weaker iPhones; could gate behind a feature flag.
- [ ] **Stehfest precision** — `N=12` is the textbook default; some
      references prefer `N=8` for speed or `N=14` for accuracy.
      Decide before coding the inverter.
- [ ] **Data persistence** — large pressure datasets will exceed the
      ~5 MB localStorage cap. IndexedDB? Blob in memory only?

---

## 8. Reference checklist for implementation

When Phase 1 starts, key references to have open:

- Bourdet, D. _Well Test Analysis: The Use of Advanced Interpretation
  Models_, Elsevier, 2002.
- Horne, R. N. _Modern Well Test Analysis_, Petroway, 1995.
- Lee, J. et al. _Pressure Transient Testing_, SPE Textbook
  Series Vol. 9, 2003.
- Cinco-Ley, H., Samaniego-V., F. & Dominguez, N. (1978).
  _Transient Pressure Behaviour for a Well with a Finite-Conductivity
  Vertical Fracture_. SPE-J Aug 1978.
- Stehfest, H. (1970). _Numerical Inversion of Laplace Transforms_,
  Comm. ACM 13.
- Ozkan, E., Raghavan, R. (1991). _New Solutions for Well-Test-Analysis
  Problems: Part 1 — Analytical Considerations_. SPE Formation
  Evaluation Sept 1991.

---

## 9. Type-Curve Model Library — Implementation Tasks

37 models in total, grouped by execution phase. Phase 1 + 2 ships
together as the launch (~10 models, covers ~80% of routine work).
The rest is a tracked backlog.

All models share the common chassis: full analytic solutions
(Laplace / Fourier transforms, Bessel functions), wellbore storage
+ skin via Laplace inversion, finite well-bore radius (no line-source
solutions), Stehfest numerical inversion of the Laplace solution.

Key reference texts to have open during implementation:
- Earlougher, R. C. _Advances in Well-Test Analysis_, SPE Monograph 5
- Bourdet, D. _Well Test Analysis: Use of Advanced Interpretation Models_
- Lee, J. _Pressure Transient Testing_, SPE Textbook Series 9
- Stehfest, H. (1970). _Numerical Inversion of Laplace Transforms_, Comm. ACM 13

### Phase 1 — Foundation (LAUNCH SCOPE)

- [x] **Stehfest Laplace inversion engine** — N=12 default, lookup table of weights, real-axis evaluator. Used by every Laplace-domain model.
- [x] **#1 Homogeneous Reservoir** — radial flow, finite-radius vertical well, WBS + skin. Most basic model; baseline for comparison. _Refs: Mavor & Cinco (SPE 7977); Gringarten (SPE 10044)._

### Phase 2 — Standard well/reservoir set (LAUNCH SCOPE)

- [x] **#3 Infinite-Conductivity Hydraulic Fracture** — vertical well + hydraulic fracture in homogeneous reservoir; high fracture conductivity → negligible pressure drop in fracture. _Ref: Gringarten, Ramey, Raghavan (SPEJ Aug 1974)._
- [x] **#4 Finite-Conductivity Hydraulic Fracture** — vertical fracture with significant pressure drop. Table-lookup solution from Cinco-Ley semi-analytic. _Ref: Cinco et al (SPE 6014)._
- [x] **#7 Inclined-Well Model** — slant well in homogeneous reservoir; transition between inclined-radial and horizontal-radial flow. _Ref: Cinco, Miller, Ramey (JPT Nov 1975)._
- [x] **#8 Horizontal Well Model** — horizontal well in homogeneous reservoir; transition between vertical and pseudo-radial flow. _Ref: Raghavan, Ozkan, Joshi (SPE 16378)._
- [x] **#10 Reservoir Boundaries — Single Linear** — image-well technique, sealing or constant-pressure. Doubling-of-slope diagnostic. _Ref: Van Poolen et al (JPT Aug 1963)._
- [x] **#10 Reservoir Boundaries — Parallel (channel)** — derivative ½-slope diagnostic; channel-width from linear flow. _Ref: as above._
- [x] **#10 Reservoir Boundaries — Closed Channel (3-sided)** — extension of parallel + end closure. _Ref: as above._
- [x] **#10 Reservoir Boundaries — Closed Rectangle** — full PSS late-time behaviour; reservoir-limits test. _Ref: as above._
- [x] **#10 Reservoir Boundaries — Intersecting** — radial-flow stabilisation related to angle of intersection. _Ref: as above._
- [x] **#10 Boundary "fog factor"** — fractional transmissibility (-1 to 1) for partially sealing / leaky faults.
- [x] **#12 Finite-Conductivity Fracture WITH Skin** — same as #4 plus fracture-face skin restricting flow. _Ref: Cinco-Ley & Samaniego (SPE 6752)._
- [x] **#30 Partial-Penetration Hydraulic Fracture** — vertical fracture height < reservoir thickness, with fracture skin. _Ref: Gringarten, Ramey (SPE 3818)._

### Phase 3 — Auto-match + Decline + Multi-rate

- [x] **Levenberg-Marquardt regression engine** — bounds, fix/float per parameter, Marquardt scaling = `diag(JᵀWJ)` (scale-invariant under reparameterisation), Jacobian-based stderr / 95% CI / AIC / R² / RMSE, residual-bootstrap option. `window.PRiSM_lm`, `window.PRiSM_bootstrap`, `window.PRiSM_runRegression`. Synthetic recovery test: Cd=98.79 / S=1.97 from Cd=10 / S=0 initials in 7 iterations (R²=0.99995).
- [x] **Multi-rate superposition** — `window.PRiSM_superposition(modelFn, rateHistory, evalTimes, params, tdNormaliser)`. Convolves arbitrary rate history including shut-ins; verified rises during drawdown and recovers during shut-in.
- [x] **Sandface-rate convolution plot** — `window.PRiSM_sandface_convolution(data, refRateIdx)` produces Agarwal equivalent-time + dp_eff. Plot id `sandface` in registry.
- [x] **#17 Fetkovich and Arps Decline-Curves** — Arps `b∈[0..1]` switches exponential / hyperbolic / harmonic; Fetkovich blends transient → BDF via logistic in ln(t). Both expose `eur` functions (closed-form Earlougher for Arps, numerical for Fetkovich). _Ref: Fetkovich (JPT Jun 1980)._
- [x] **DCA Quick Run port** — Arps, Duong (2011 shale), Stretched-Exponential (Valko 2009) all live as PRiSM rate-domain models with EUR helpers. Legacy `wts_dca` localStorage key migrated to `wts_prism._legacy` on first PRiSM open.

### Phase 4 — Specialised single-well

- [x] **#2 Double-Porosity Reservoir** — Warren-Root with three interporosity-flow modes: PSS / 1DT (slab-matrix) / 3DT (sphere-matrix). Small-arg series + large-arg asymptote guards on `tanh`/`coth`. ω, λ params. Homogeneous-limit sanity check passes (small-λ pd=0.0976, large-λ pd=0.0974). _Ref: Mavor & Cinco (SPE 7977); Gringarten (SPE 10044)._
- [x] **#5 Partial-Penetration Model** — phenomenological Laplace-domain blend of three superposed kernels (sigmoid weight) capturing spherical-flow transition, hp/h, Kv/Kh. Stabilisations match early/late ~5%. (NOT exact Brons-Marting source-function integration — flagged as future-work.) _Ref: Gringarten, Ramey (SPEJ Aug 1974)._
- [x] **#16 Vertical Pulse-Test** — 2-D Green's-function effective-radial-distance form `K0(sq · √(heff² + Δz_eff²))` capturing time-lag + amplitude attenuation. Δz_eff = Δz/√(Kv/Kh) · √(hp/h). Avoids ringing under WBS folding. _Ref: Gringarten, Ramey (SPEJ Aug 1974)._

### Phase 5 — Composite + Multi-layer

- [ ] **#6 Two-Layer Reservoir With Cross-Flow** — bi-layer / dual-permeability, λ controls cross-flow. _Ref: Bourdet (SPE 13628)._
- [ ] **#9 Radial Composite Reservoir** — two concentric zones, mobility + storativity ratios. Common for water-injection. _Refs: Abbaszadeh & Medhat (SPE Reservoir Eng Feb 1989); Sutman et al (SPE 8909)._
- [ ] **#11 Multi-Layer Reservoir With Cross-Flow** — N layers, λ between each pair, ω + κ per layer. _Ref: Economides (SPE 14167)._
- [ ] **#14 Multi-Layer Reservoir Without Cross-Flow** — commingled production from isolated layers; per-layer initial pressure, perm, skin. _Ref: Kuchuk & Wilkinson (SPE 18125)._
- [ ] **#15 Linear Composite Reservoir** — homogeneous reservoir with linear discontinuities; up to 5 zones.
- [ ] **#20 General Heterogeneity Radial/Linear Composite** — three-zone composite (R-zone + ±X-zones), up to 9 discontinuities each, piecewise-linear or step-wise.
- [ ] **#21 General Heterogeneity Radial Composite** — refines #9 with up to 9 piecewise-linear or step-wise discontinuities in radial direction.

### Phase 6 — Interference & Multi-lateral

- [ ] **#13 Interference Test Model** — observation well pressure response from a flowing well; both wells have storage + skin; line-source. _Ref: Ogbe & Brigham (SPE 13253)._
- [ ] **#19 Multi-Layer Horizontal-Well With Cross-Flow** — single horizontal well in N-layer reservoir with full transient inter-layer flow. _Ref: Kuchuk (SPE 22731)._
- [ ] **#22 Multi-Layer No-Cross-Flow Hydraulic-Fracture** — commingled production, each layer fractured. _Ref: Kuchuk & Wilkinson (SPE 18125)._
- [ ] **#23 Multi-Layer No-Cross-Flow Horizontal-Well** — commingled production, each layer with horizontal completion. _Ref: as above._
- [ ] **#24 Inclined-Well in Multi-Layer With Cross-Flow** — slant well penetrating one or more layers with full transient cross-flow. _Ref: Kuchuk (SPE 22731)._
- [ ] **#25 Multi-Lateral Well in Multi-Layer With Cross-Flow** — multiple horizontal segments (star or parallel layout). _Ref: Kuchuk (SPE 22731)._
- [ ] **#26 Multi-Layer Multi-Perforation** — 1–4 perforated intervals at arbitrary depths, layered reservoir with cross-flow. _Ref: Kuchuk (SPE 22731)._
- [ ] **#27 Multi-Layer Horizontal-Well Interference-Test** — pressure response between two horizontal wells in layered reservoir. _Ref: Kuchuk (SPE 22731)._
- [ ] **#28 Multi-Layer Multi-Perforation Interference-Test** — up to 3 producing perforated intervals + 1 observation. _Ref: Kuchuk (SPE 22731)._
- [ ] **#29 Inclined-Well Interference-Test** — between two inclined wells in homogeneous or double-porosity reservoir. _Refs: Cinco et al (JPT Nov 1975); Kuchuk & Wilkinson (SPE 18125)._
- [ ] **#31 Linear-Composite Interference-Test** — observation pressure in linear-composite reservoir, up to 5 zones. _Ref: as #15._
- [ ] **#32 Linear-Composite Multi-Lateral Well** — multi-lateral producer in linear-composite reservoir.
- [ ] **#34 Linear-Composite Multi-Lateral Interference-Test** — interference at an observation well from a multi-lateral producer.
- [ ] **#35 General Multi-Layer No-Cross-Flow Model** — each layer can be a different well/reservoir type (vertical homogeneous through to horizontal in linear-composite). Maximum flexibility, maximum compute.
- [ ] **#36 Interference-Test in Multi-Layer With Cross-Flow** — pressure at arbitrary (x, y) point in any layer, with PSS λ-controlled cross-flow.
- [ ] **#37 Radial-Composite Interference-Test** — pressure at arbitrary (x, y) in 2-zone radial-composite reservoir.

### Phase 7 — Specialised solvers (reach goals)

- [ ] **#18 User-Defined Model** — tabulated `td`/`pd` type-curves with interpolation/extrapolation, log-log and semi-log; user supplies the table file in the documented format.
- [ ] **#38 Water Injection Model** — non-linear semi-analytic two-phase displacement (Buckley-Leverett-like). Requires injection history (negative or zero rates only) and non-zero water compressibility. Largest single piece of work in the catalogue.

### Cross-cutting tasks (touch every phase)

- [ ] Common parameter UI per model: list, units, bounds, fix/float toggle.
- [ ] Schematic SVG per model — vessel cross-section / plan-view diagrams matching the references.
- [ ] Per-model "Specialised analysis keys" port — STABIL, HALFSL, OMEGA, LAMBDA, FAULT, CHANEL, ANGLE, INJSTB, INJSLP, PPNSTB, PPNSLP, PPNSKN, HORSLP, HORSTB, BND-ON, BND-DV, 3-SIDE, AUTOSL, 1/4SLP, SPHERE. (These are click-on-plot helpers that mark a slope or stabilisation and back-calculate parameters.)
- [ ] Result reporting: parameter table with units + uncertainty + reference.
- [ ] Plot export (PNG + into PDF report).

### Post-launch decision points

After Phase 2 ships, evaluate before committing to Phase 3+:
- Real usage telemetry (GA4 events on PRiSM → which models get clicked?)
- Reasonable to scope Phase 3 (auto-match) before Phase 4–7 since regression amplifies the value of every existing model.
- Phases 5 and 6 are very compute-heavy (Kuchuk multi-layer with full transient cross-flow); decide if acceptable to push these to web-only and mark "iOS = limited model set" in PRiSM intro screen.

---

_Last updated: 2026-04-26._
_All decisions in §⚙️ are locked. §9 task list is the implementation queue._
_Phases 1+2 shipped 2026-04-25 (`32cf1b0`)._
_Phases 3+4 shipped 2026-04-26 — LM regression engine, multi-rate superposition, sandface convolution, Arps + Duong + SEPD + Fetkovich decline, double-porosity (3 modes), partial-penetration, vertical pulse-test, plus full multi-format (CSV / TSV / DAT / ASC / XLSX / XLS / ODS) data-tab parser with column-mapper, MAD/Hampel/moving-avg filters, Nth/log/time-bin decimation, unit converters._
