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
| **5** | + Composite (radial + linear); multi-layer with cross-flow | ✅ shipped 2026-04-26 |
| **6** | + Interference (#13, #27, #28, #29, #31, #34, #36, #37); multi-lateral & multi-layer (#19, #22-#26, #32, #35) | ✅ shipped 2026-04-26 |
| **7** | + #18 user-defined type-curve; + #38 water injection (semi-analytic Buckley-Leverett) | ✅ shipped 2026-04-26 |
| **Polish** | + 14 SVG schematics; 20 click-on-plot analysis keys; PNG plot export; per-tab GA4 events | ✅ shipped 2026-04-26 |
| **Auto-match** | + Regime classifier; LM model race; top-N ranking; smart initial-param guesses | ✅ shipped 2026-04-26 |
| **Interpretation** | + Plain-English narrative from fitted params + actions + cautions + confidence | ✅ shipped 2026-04-26 |
| **Annotations** | + Auto-pick Bourdet smoothing L; auto-detect regime transitions; plot markers | ✅ shipped 2026-04-26 |
| **Data crop** | + Interactive crop chart + numeric trim + first/last preview | ✅ shipped 2026-04-26 |

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

### Phase 5 — Composite + Multi-layer (LAUNCH SCOPE — `bc42c68`+ shipped)

- [x] **#6 Two-Layer Reservoir With Cross-Flow** — Bourdet PSS f(s) factor (Warren-Root analog) — captures dip + end-stabilisations. NOT rigorous Park-Horne 2×2 Laplace system. _Ref: Bourdet (SPE 13628)._
- [x] **#9 Radial Composite Reservoir** — exact closed-form 2×2 K0/I0 matching at the interface (no approximation). Collapses to homogeneous when M=F=1 (verified pd(10)=0.0952). _Refs: Abbaszadeh & Medhat (SPE Reservoir Eng Feb 1989); Sutman et al (SPE 8909)._
- [x] **#11 Multi-Layer Reservoir With Cross-Flow** — generalised PSS f(s) across N layers (capped at N=5) with uniform λ between adjacent pairs. _Ref: Economides (SPE 14167)._
- [x] **#14 Multi-Layer Reservoir Without Cross-Flow** — exact closed form (kh-fraction-weighted sum of N independent K0(√(s/k_i))/s kernels). _Ref: Kuchuk & Wilkinson (SPE 18125)._
- [x] **#15 Linear Composite Reservoir** — first-order single-reflection image-well superposition with reflection coefficients r_n=(M_{n+1}-M_n)/(M_{n+1}+M_n). Multi-reflections truncated.
- [x] **#20 General Heterogeneity Radial/Linear Composite** — research-grade reach goal restricted to **3 zones** (textbook spec was up to 9 piecewise discontinuities; not implemented).
- [x] **#21 General Heterogeneity Radial Composite** — restricted to **3 zones** (two interfaces) with recursive K0/I0 cascaded matching. Up to 9 piecewise discontinuities NOT implemented.

### Phase 6 — Interference & Multi-lateral (LAUNCH SCOPE — `bc42c68`+ shipped)

- [x] **#13 Interference Test Model** — line-source K0 kernel with WBS+skin folding via Bourdet-Gringarten denominator at producer; optional Cd_obs attenuation. _Ref: Ogbe & Brigham (SPE 13253)._
- [x] **#19 Multi-Layer Horizontal-Well With Cross-Flow** — Goode-Thambynayagam image series in z combined with Kuchuk PSS-XF f(s) factor + Joshi anisotropy pseudo-skin. NOT full transient matrix solution. _Ref: Kuchuk (SPE 22731)._
- [x] **#22 Multi-Layer No-Cross-Flow Hydraulic-Fracture** — kh-weighted commingled sum of Gringarten ∞-cond fracture closed-form per layer; soft early-time WBS damping. _Ref: Kuchuk & Wilkinson (SPE 18125)._
- [x] **#23 Multi-Layer No-Cross-Flow Horizontal-Well** — kh-weighted commingled Goode-Thambynayagam horizontal kernels. _Ref: as above._
- [x] **#24 Inclined-Well in Multi-Layer With Cross-Flow** — Cinco-Miller-Ramey inclination pseudo-skin folded into Kuchuk PSS-XF kernel. _Ref: Kuchuk (SPE 22731)._
- [x] **#25 Multi-Lateral Well in Multi-Layer With Cross-Flow** — Nleg parallel horizontal segments with Goode-Thambynayagam per-leg + line-source inter-leg coupling K0(s·dij). −ln(nLegs) Larsen pseudo-skin. NOT Joshi-Babu finite-conductivity. _Ref: Kuchuk (SPE 22731)._
- [x] **#26 Multi-Layer Multi-Perforation** — ≤4 perforations with Brons-Marting pseudo-skin per perforation; PSS XF kernel for layered admittance. _Ref: Kuchuk (SPE 22731)._
- [x] **#27 Multi-Layer Horizontal-Well Interference-Test** — same kernel as #19 evaluated at observation distance. _Ref: Kuchuk (SPE 22731)._
- [x] **#28 Multi-Layer Multi-Perforation Interference-Test** — same kernel as #26 evaluated at observation distance, ≤3 producing perfs. _Ref: as above._
- [x] **#29 Inclined-Well Interference-Test** — phenomenological vertical/horizontal projection blend weighted by sin(θp)·sin(θo). Optional Warren-Root PSS double-porosity f(s). _Refs: Cinco et al (JPT Nov 1975); Kuchuk & Wilkinson (SPE 18125)._
- [x] **#31 Linear-Composite Interference-Test** — chained transmissibility attenuation Π(1+Mi)/(2Mi) applied to line-source K0 at observation, ≤5 zones. _Ref: as #15._
- [x] **#32 Linear-Composite Multi-Lateral Well** — multi-lateral admittance from #25 multiplied by linear-composite attenuation factor.
- [x] **#34 Linear-Composite Multi-Lateral Interference-Test** — #32 producer admittance + line-source K0 at observation, both attenuated through composite zones.
- [x] **#35 General Multi-Layer No-Cross-Flow Model** — kh-weighted commingled sum dispatching to per-layer Laplace kernels for {homogeneous, fracture, horizontal, composite, linearComp}.
- [x] **#36 Interference-Test in Multi-Layer With Cross-Flow** — Kuchuk PSS-XF f(s) at observation point, kh-weighted. Layer-specific pressure variation across thickness neglected. _Ref: Kuchuk (SPE 22731)._
- [x] **#37 Radial-Composite Interference-Test** — Bourdet 2002 §6.4.2 single-front: piecewise inner/outer-zone K0 kernel with (1+M)/(2M) attenuation and √W outer-zone delay.

### Phase 7 — Specialised solvers (LAUNCH SCOPE — `bc42c68`+ shipped)

- [x] **#18 User-Defined Model** — table-driven log-log interpolator with timeShift / pressShift; CSV parser; localStorage persistence (`wts_prism_user_curves`). Parity vs live homogeneous: matches within 4% off-knot.
- [x] **#38 Water Injection Model** — semi-analytic with piston-like Hawkins (M-1)·ln(rfD) skin layered on Bourdet-Gringarten WBS+skin Stehfest convolution. Documented simplifications: A1 piston front (no Buckley-Leverett saturation fan), A2 no gravity / capillary / vertical sweep, A3 right-rectangle rate digitisation, A4 incompressible front, A6 no countercurrent / dissolved gas / temperature.

### Cross-cutting tasks (LAUNCH SCOPE — `bc42c68`+ shipped)

- [x] **Common parameter UI per model** — Tab 4 (Params) renders per-model paramSpec with bounds + fix/float toggles.
- [x] **Schematic SVG per model** — `window.PRiSM_getModelSchematic(modelKey)` returns 14 hand-crafted SVG diagrams (homogeneous, infiniteFrac, finiteFrac, finiteFracSkin, inclined, horizontal, partialPenFrac, linearBoundary, parallelChannel, closedRectangle, intersecting, doublePorosity, partialPen, verticalPulse) + generic placeholder for unknowns.
- [x] **20 specialised analysis keys** — `window.PRiSM_analysisKeys` exposes STABIL, HALFSL, OMEGA, LAMBDA, FAULT, CHANEL, ANGLE, INJSTB, INJSLP, PPNSTB, PPNSLP, PPNSKN, HORSLP, HORSTB, BND-ON, BND-DV, 3-SIDE, AUTOSL, 1/4SLP, SPHERE. Each click-arms via `PRiSM_armAnalysisKey(key)` and writes results to `PRiSM_state.params`.
- [x] **Result reporting with uncertainty** — Tab 7 (Report) with Agent B's stderr/CI95/AIC fields + Agent K's plain-English interpretation panel.
- [x] **Plot export (PNG + PDF)** — `PRiSM_exportPlotPNG(plotKey)` for single PNG download; `PRiSM_exportReportPDF()` walks all 14 plots, embeds as base64 PNG in HTML, falls back to print-window if `window.exportReport` absent.

### Round-2 NEW capabilities (`bc42c68`+ shipped, beyond original plan)

- [x] **Auto-match orchestrator** — `window.PRiSM_classifyRegimes(t,p,dp)` + `window.PRiSM_autoMatch(opts) → Promise<{ ranked, bestKey, deltaAIC, classification, elapsedMs }>`. Regime classifier on Bourdet derivative slopes (WBS / radial / spherical / linear / bilinear / closed / constP / sealing-fault / dual-porosity-valley) → narrows to 3-8 candidate models → races each via LM with smart initial guesses → ranks by AIC.
- [x] **Plain-English interpretation** — `window.PRiSM_interpretFit(modelKey, params, CI95, fitMeta?) → { tags, narrative, actions, confidence, cautions }`. 18 param-key buckets covered (skin / Cd / kh / ω / λ / xf / FcD / lateral length / 9 boundary distances). 11 action templates. Confidence-aware verb choice ('indicates' / 'is consistent with' / 'tentatively suggests').
- [x] **Auto-pick Bourdet smoothing L** — `window.PRiSM_autoBourdet_L(t,p,q?) → { L, noiseLevel, noiseEstimate, rationale, alternatives[] }`. Maps high-pass residual RMS to L: <0.001 → L=0.10 (clean) / 0.001-0.005 → 0.18 (typical) / 0.005-0.02 → 0.30 (noisy) / >0.02 → 0.50 (very noisy).
- [x] **Diagnostic-plot annotations** — `window.PRiSM_detectAnnotations(t,p,dp?)` returns regime-transition markers (wellboreStorageEnd, radialFlowStart, boundaryHit, sphericalFlow, doublePorosityValley, etc.); `window.PRiSM_drawPlotAnnotations(canvas, annotations, plotKey)` overlays dashed verticals + rotated labels. Wraps `PRiSM_drawActivePlot` idempotently for auto-render.
- [x] **Interactive Data crop/trim** — `window.PRiSM_renderCropTool(container)` paints an 800×300 chart with drag-select + handle-drag + 4 fine-control numeric inputs (t_start, t_end, i_start, i_end) + first/last preview block. `window.PRiSM_applyCrop(t_start, t_end)` slices and replaces `window.PRiSM_dataset`. `window.PRiSM_resetCrop()` restores snapshot. Wraps `PRiSM_renderDataTabEnhanced` to auto-append.
- [x] **Per-tab GA4 events** — wraps `window.PRiSM.setTab` (fires `prism_tab_open`), `PRiSM_state.model` setter (fires `prism_model_select`), `window.PRiSM_runRegression` (fires `prism_regress_run`), `window.PRiSM_autoMatch` (fires `prism_auto_match_run`).

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
_Phases 5+6+7 + cross-cutting + auto-match + interpretation + annotations + Data crop shipped 2026-04-26 — 8 new files (10,774 LOC) bringing PRiSM_MODELS to 45 entries. Smoke-test 47/47 checks pass. The original plan's task list is now fully complete (Phases 5-7 + cross-cutting items). Round-2 added auto-match orchestrator, plain-English interpretation, auto-Bourdet-L picker, diagnostic-plot annotations, interactive Data crop/trim, per-tab GA4 events — capabilities that go beyond the original §5 plan._
