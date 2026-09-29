# H2Oil Well Testing Suite: roadmap

Status: planning document, updated 2026-09-29 after v1.7. Owner: H2Oil Engineering.

**v1.7 shipped (DONE):** calculators #1–#4 (`gasdeliv`, `oilipr`, `flareghg`, `h2sroe`) on the new plug-in calculator registry (Round-9, `prism-build/4N-calc-*.js`), and an accuracy audit of the host calculators in groups G1–G5 (§1.5). Everything not marked DONE is the forward plan.

This plan covers three areas:

1. New field calculators, ranked by value against effort.
2. Next steps for PRiSM (well test analysis).
3. Platform work: offline use, sharing, multi-well projects, report templates and performance.

The build specs for the first four calculators were in a separate spec, `NEW-CALCS-SPEC.md`, kept with the working notes for the v1.7 batch. New calculators are now added as one self-registering file each (see "Adding a calculator" in `CLAUDE.md`); the host route table, sidebar and dashboard need no edits.

## How to read this plan

**Value**

| Rating | Meaning |
|---|---|
| **H** | Used on most jobs, or needed for a safety or regulatory deliverable |
| **M** | Used regularly by one discipline |
| **L** | Used occasionally |

**Effort** assumes one developer working with Claude, and includes tests, units tagging, report capture and release notes.

| Rating | Meaning |
|---|---|
| **S** | Up to 3 developer-days |
| **M** | 1 to 2 developer-weeks |
| **L** | More than 2 developer-weeks |

**Dependencies** name the modules, files or earlier roadmap items that a piece of work needs.

**Ground rules for every item.** These are the project conventions in `CLAUDE.md`.
- **Units.** Calculations stay in field units internally. The units layer (`22-units.js`) converts tagged inputs for metric users.
- **Dependencies.** No external runtime libraries. The only exceptions are the on-demand loads that already exist (spreadsheet import and the 3D view).
- **Layout.** Every page works at 375 px wide in the dark theme.
- **Reports and saving.** A new page gets PDF/PNG reports, Quick Report snapshots, autosave and project-file save for free if it uses the host building blocks:
  - `.card` and `.rbox` blocks;
  - `.fg-item` inputs;
  - `.rrow` results inside an element whose id ends in `_res`;
  - an id on every control.

---

## 1. Missing calculators

### 1.1 What the app already has (checked against the code on 2026-09-29)

The route keys are the keys in the host route table (`const pages = {…}`) plus the plug-in registry (`window.WTS_calcRegistry`, marked *(v1.7)*).

| Sidebar group | Route key: what it covers today |
|---|---|
| Well Testing | `aga3`: orifice gas rate per AGA-3 / API MPMS 14.3.<br>`choke`: dual choke, intermediate pressure, equivalent bean, critical-flow check.<br>`chokeflow`: gas rate through a fixed choke by coefficient; oil rate by Gilbert and Ros.<br>`chokecnv`: choke size conversions.<br>`bottomsup`: bottoms-up time.<br>`mcfshr`: meter correction factor and shrinkage from surge-tank readings.<br>`casing`: casing/tubing capacity from two short built-in lists.<br>`wts`: live Well Test Simulator (2D/3D) with an API RP 14E C-factor velocity check, J-T cooling, heater duty and hydrate risk per segment |
| Test System Safety | `esdhi` / `esdlo`: ESD high and low pilot settings.<br>`hydrate`: hydrate temperature plus methanol/glycol dosing (Hammerschmidt).<br>`liquidline`: LCV gas blow-by and restriction-orifice sizing.<br>`pipelife`: remaining life from sand erosion (Salama).<br>`h2sroe` *(v1.7)*: H2S radius of exposure, SO2 from flaring sour gas, scavenger dosing |
| Production & Reservoir | `oilgas`: oil rate with VCF, BS&W, meter factor and shrinkage; orifice gas rate; GOR/CGR.<br>`solgor`: solution GOR (Standing, Vasquez-Beggs).<br>`prism`: PTA / RTA / DCA workshop.<br>`gasdeliv` *(v1.7)*: back-pressure and LIT deliverability, AOF.<br>`oilipr` *(v1.7)*: PI, Vogel/composite with Standing FE, Fetkovich, future IPR |
| Separation & Vessels | `sep`: retention time.<br>`seprate`: Souders-Brown rating.<br>`sephand`: full handling check with RP 14E outlet erosional screening |
| Safety & Process | `flare`: API 521 radiation and noise.<br>`prv`: API 520/526 relief sizing.<br>`vessel`: ASME shell and head thickness.<br>`flamearr`: flame arrestor.<br>`arc`: automatic recirculation valve.<br>`flareghg` *(v1.7)*: flared volume, heat released, CO2/CH4/N2O/CO2e, SO2 |
| Process Equipment | `pipesz`: single-phase velocity plus Darcy pressure drop.<br>`pumpsz`, `turbmeter` (API MPMS 5.3), `heater`, `aircomp` |
| Electrical | `gensz`, `cablesz`, `vdrop`, `elec` |
| Fluid & Field Calcs | `gascalc`: gas velocity, quick volume, gas gradient; Z must be typed in.<br>`fluid`: API correction, bubble point, shrinkage.<br>`tank`, `chem` (injection rate and chloride titration), `units`, `analogsig` |

**Now present (v1.7, DONE):** Vogel and other IPR (`oilipr`); AOF, deliverability and back-pressure analysis (`gasdeliv`); flare emissions and CO2e (`flareghg`); H2S radius of exposure and scavenger dosing (`h2sroe`).

**Still absent.** A code search found nothing for any of these:
- Beggs–Brill or any multiphase flowline method;
- well kill or kill weight;
- scaling indices (Langelier / Stiff-Davis / Oddo-Tomson);
- meter proving;
- line heat loss;
- gas lift;
- cement or brine calculations.

**Covered in part:**
- **Erosional velocity (RP 14E) and sand erosion.** Spread across `wts`, `sephand` and `pipelife`, with no stand-alone check.
- **BS&W and shrinkage corrections.** Covered by `oilgas` and `mcfshr`.
- **Wellbore volume.** `casing` only, with two short tubular lists.

### 1.2 Ranked list

The rank balances value to surface well-test, production and safety engineers against effort. Items 1–4 were the v1.7 batch and are **DONE**. Items 5–19 are the forward plan.

| # | Calculator (proposed route) | Main users | Value | Effort | Overlap with existing pages | Dependencies |
|---|---|---|---|---|---|---|
| 1 | **DONE (v1.7).** **Gas deliverability & AOF** (`gasdeliv`, Production & Reservoir). Flow-after-flow, isochronal, modified isochronal and single-point tests. Back-pressure (C and n) and laminar-inertial-turbulent (LIT) fits, AOF, IPR table and plot | Well test, reservoir | H | M | None | None to start. Later it feeds #4 (escape rate = AOF), PRiSM gas work (§2, N3) and the report templates (§3) |
| 2 | **DONE (v1.7).** **Oil well IPR** (`oilipr`, Production & Reservoir). Straight-line PI, Vogel, composite (PI above the bubble point, Vogel below), Standing flow efficiency, Fetkovich multipoint, future IPR, rate ↔ pwf readouts | Production, well test | H | S | None | None. Later it can take J and FE from PRiSM's skin results (`34-semilog-skin.js`) |
| 3 | **DONE (v1.7).** **Flare emissions & flared volumes** (`flareghg`, Safety & Process). Flared volume, heat released, CO2, CH4 slip, N2O, CO2e (AR4/AR5/AR6 GWPs), SO2, unburned H2S; CO2 from the liquid burner; Tier-1 reference cross-check | Test supervisors, HSE, reporting | H | S | `flare` covers radiation and noise only | None. Later it takes the flare rate from `wts` and feeds a daily-report template |
| 4 | **DONE (v1.7).** **H2S safety** (`h2sroe`, Test System Safety). 100 and 500 ppm radius of exposure (Pasquill-Gifford screening formulas used by US regulators), SO2 from flaring sour gas, triazine-type scavenger dosing | Safety, well test | H | S | None (`aga3` uses H2S % only for metering) | Optional: AOF from #1 |
| 5 | **Well kill & bullhead** (`wellkill`). Kill-weight fluid from reservoir pressure and TVD with overbalance; bullhead volume per string section (tubing, casing below packer, rathole) plus over-displacement; pump strokes; maximum surface pressure against fracture gradient; U-tube check; brine selection guide | Well test, completions, safety | H | M | `casing` (capacity), `bottomsup` (time only) | A shared tubular table: extend `casingData` / `tubingData` into one module with drill pipe and liners. A liquid-gradient helper (#19) |
| 6 | **Orifice plate selection** (inverse AGA-3). Picks the bore that keeps the differential between 20 % and 80 % of the transmitter range for a target rate, lists the next plate up and down, and shows plate-change points | Test crews | H | S | `aga3` (forward calculation only) | Refactor `calcAGA3` into a pure `WTS_aga3_compute(inputs)` that both pages call |
| 7 | **Gas PVT quick page**. Z (DAK / Hall-Yarborough), Bg, density, viscosity (Lee-Gonzalez-Eakin), pseudo-criticals with sour-gas correction, speed of sound | Everyone | H | S | The correlations are in PRiSM `16-pvt.js` but have no host page. `gascalc` asks the user to type Z | `window.PRiSM_*` PVT functions. Adds a "use calculated Z" button to `gascalc` and `aga3` |
| 8 | **Separator sampling & GOR QC**. Separator vs stock-tank GOR through the shrinkage factor. Gas-rate re-computation with the laboratory gas gravity and Z. Recombination GOR. Sample validity checks: opening pressure vs separator pressure, laboratory saturation pressure vs separator conditions, duplicate-sample agreement. API RP 44 practice | Well test, sampling, PVT | H | M | `oilgas`, `solgor`, `mcfshr` | #6 (AGA-3 compute), 16-pvt (Rs, Bo) |
| 9 | **Choke performance & critical flow**. Critical pressure ratio from k (Cp/Cv); subcritical and critical gas flow through beans. Multiphase choke family curves (Gilbert, Ros, Baxendell, Achong forms) with q vs wellhead pressure for several beans. Bean-up planning | Well test | M–H | M | `chokeflow`, `choke` | #7 (k, Z) |
| 10 | **Multiphase flowline pressure drop**. Beggs–Brill with Payne corrections, elevation, flow-pattern map; per segment from wellhead to separator and flare | Production, well test | H | M–L | `pipesz` (single phase); simulator segment model | 16-pvt (Rs, Bo, μ, Z, σ); #7 |
| 11 | **SO2 / H2S dispersion screening**. Gaussian plume with Briggs rural σy/σz for stability classes A–F and buoyant plume rise from the flare heat release; ground-level concentration vs distance against IDLH/STEL/TWA | HSE | M–H | M | `flare` (radiation), #4 (radius of exposure) | #3 and #4 (release rates) |
| 12 | **Line heat loss & arrival temperature**. Bare, insulated or buried pipe; wind; J-T drop at chokes; arrival temperature per segment | Well test (hydrates, wax) | M | M | `hydrate` needs a temperature input; the simulator has J-T only | Feeds `hydrate` and `wts` |
| 13 | **Meter proving & net standard volume**. Meter factor from prover runs with a repeatability check; CTL and CPL from the API MPMS 11.1 equations (closed form, no tables); S&W; net standard volume per API MPMS 12.2 | Test crews, allocation | M | M | `oilgas` applies MF, BS&W and shrinkage as typed values | None |
| 14 | **Scale & water analysis**. Ionic strength; Langelier and Stiff-Davis indices; Oddo-Tomson saturation indices for calcite, barite, celestite and gypsum/anhydrite vs T and P | Production chemistry | M | M | `chem` (chloride titration only) | None |
| 15 | **Erosional velocity & sand quick check**. RP 14E C-factor selection with a sand-rate screen on one line | Well test | M | S | Already inside `wts`, `sephand` and `pipelife` | Reuse `WTS_erosion_rate_salama`. Best added as a card on `pipesz`, not a new page |
| 16 | **Gas lift quick design**. Injection-gas gradient, unloading-valve spacing, gas requirement | Production | M | L | None | #10, #7 |
| 17 | **Cement & completion fluids**. Slurry volume and yield, brine blending density and crystallisation-point guide | Completions | L–M | M | None | A small inline brine table (no data file) |
| 18 | **Net oil & BS&W corrections**. S&W, VCF and shrinkage in one audit trail | Test crews | L–M | S | Mostly covered by `oilgas` / `mcfshr` | Fold into #13 |
| 19 | **Liquid / mixed gradient & surface ↔ bottomhole conversion**. Static liquid column, gas cap, mixed column | Well test | M | S | `gascalc` covers gas columns only | Used by #5 |

**Why 1–4 first (shipped in v1.7).**
- **Deliverability and IPR** are standard deliverables of every gas and oil well test. Regulators ask for them:
  - an AOF or deliverability test is required within 90 days of completing a gas well in Texas;
  - a stabilised one-point test is accepted there.
- **Flaring volumes and emissions** are reported on every test that flares (flare consents, emissions trading, US GHG reporting).
- **H2S radius of exposure** decides whether a contingency plan is needed.

All four are closed-form, need no data files, and reuse the host page pattern. Together they fit in one release. Item 1 feeds item 4 (escape rate = AOF): the H2S page has a "Use AOF from Gas Deliverability" button.

**Why not the others yet.**
- **Well kill (#5).** Needs a shared tubular table first. That is a cross-page refactor of `casing`.
- **Multiphase (#10) and dispersion (#11).** These are larger, and should be checked against published cases before release.
- **Gas PVT (#7) and orifice selection (#6).** Cheap and high value. They are the first items of the next batch.

### 1.3 Method notes for the NEXT items

- **Well kill (#5).**
  - Kill weight: KWF [ppg] = p_res / (0.052 · TVD_perfs) + overbalance.
  - Bullhead volume = Σ(section capacity × length) + over-displacement.
  - Maximum surface pressure while bullheading = frac gradient × TVD − hydrostatic of the fluid in the hole.
  - Show a pump schedule: step pressures against cumulative volume.
  - The brine guide lists the usual maximum densities of single-salt brines (NaCl, KCl, CaCl2, NaBr, CaBr2) as an inline reference table.
- **Orifice selection (#6).** Solve AGA-3 for the bore at a target differential; standard bores come from an inline list.
- **Sampling QC (#8).**
  - GOR_ST = GOR_sep × shrinkage.
  - Gas-rate correction: q_corr = q_field × √(SG_field/SG_lab) × (F_pv,lab/F_pv,field).
  - Flag samples whose laboratory saturation pressure differs from the separator pressure at separator temperature by more than a user tolerance.
- **Choke (#9).**
  - Critical ratio (p2/p1)_c = (2/(k+1))^(k/(k−1)).
  - Gas rate through a bean from the standard compressible-orifice form with discharge coefficient Cd.
  - Multiphase choke correlations of the form q = p1 · S^b / (a · GLR^c), with published constants per author.
- **Multiphase (#10).** Beggs & Brill (1973), with the Payne et al. (1979) holdup corrections. Validate against the published worked examples before release.
- **Dispersion (#11).**
  - C(x,0,0) = Q/(π u σy σz) · exp(−H²/2σz²), with Briggs (1973) rural σ formulas and flare plume rise from the net heat release.
  - Clearly labelled as screening only, not a substitute for a site dispersion study.

### 1.4 Open points on the v1.7 calculators

- **Oil IPR metric J.** J shows as m³/d per psi in metric (mixed units). A proper m³/d/kPa is a small change.
- **Gas deliverability report.** Blank test-point rows 4–6 are captured in the report because their "Transient" dropdown counts as content.
- **Harness gap.** The headless DOM has no `table.rows`, so table capture in reports for the new pages is checked in the browser only.

### 1.5 Calculator accuracy audit (G1–G5): DONE (v1.7)

Every host calculator was audited against separate hand calculations, fixed where wrong, and given regression tests (`prism-build/tests/calc-g1…g5.test.js`, 97 tests). Some fixes change numbers users may have relied on; the v1.7 release notes list them.

| Group | Calculators | Fixed |
|---|---|---|
| G1 metering & chokes | `aga3`, `choke`, `chokeflow`, `chokecnv`, `gascalc`, `mcfshr`, `turbmeter` | AGA-3 base-temperature factor (Ftb = Tb/519.67) and pseudo-critical note; dual-choke gas and multiphase rates and P2; gas velocity (÷1000); quick gas volume; meter-factor and turbine checks; input guards. Metric companions (Sm³, kPa(g), m³/d, mm²) on AGA-3 and dual choke |
| G2 fluids & production | `fluid`, `solgor`, `oilgas`, `casing`, `units`, `tank`, `bottomsup`, `analogsig` | Separator shrinkage; API at 60 °F; 4½-in casing IDs; ft³/min conversion; oil & gas orifice Cd (ISO 5167-2 flange taps) and metric dP at 60 °F water; GOR/CGR "—" on zero flow; fluid tab keeps metric tags |
| G3 separation & process | `sep`, `seprate`, `sephand`, `vessel`, `heater`, `chem` | Gas volume ×Z; two-phase liquid outlet (oil + water); Souders–Brown K within GPSA ranges; verdicts and thin-wall validity in reports; vessel thickness; heater duty split by water cut; chemical rate factor and zero flow; metric units on `sephand`; 375 px fix |
| G4 safety | `flare`, `prv`, `flamearr`, `arc`, `esdhi`, `esdlo`, `hydrate`, `liquidline`, `pipelife` | Non-certified liquid PRV uses the selected overpressure (Kp); PRV and flame-arrestor metric units; flare, ARC and flare layout fixes; ESD inventory at 60 °F; hydrate correlation; liquid-line blow-by/RO/vent equations; pipe-life MAWP and schedule table |
| G5 mechanical & electrical | `pipesz`, `pumpsz`, `aircomp`, `gensz`, `cablesz`, `vdrop`, `elec` | Gas pipe sizing: ×Z, RP 14E erosional cap and dP limit; liquid gravity ambiguity; mud-pump triplex factor; IEC ambient factors and IEC 60228 conductor resistance; air-compressor rounding; generator sizing basis shown; kW↔hp constant |

**Audit findings still open (forward plan):**
- **Units coverage.** G2 pages (except Tank) and `seprate` show results in imperial in Metric mode (labels correct); bubble-point and shrinkage inputs are not unit-tagged; the metric gas-rate label "Mm³/d" should read "10³ m³/d"; the AGA-3 `a_dP` field still uses the 39.2 °F water column (the oil & gas page now uses 60 °F). Fold into P7.
- **AGA-3 vs oil & gas Cd.** The two pages use different Cd and Z correlations (0.1–0.6 % apart). Settle on one shared `WTS_aga3_compute` (roadmap #6).
- **Correlation ranges.** Papay Z in `oilgas` is only reliable below Ppr ≈ 3; Vasquez & Beggs gas gravity is not corrected to 100 psig; turbine-meter cavitation uses fixed vapour pressures; the 7/64 and 20/64 entries of the choke coefficient table look out of line.
- **Domain decisions needed.** The ESD Lo-Pilot reach criterion can essentially never pass; pipe-life erosion is a calibrated fit (not Salama/DNV) and does not scale with sand rate; "Schedule 180" is not an ASME B36.10 schedule but is used by defaults and saved projects; the flame-arrestor element K is generic.

### 1.6 Deliberately not planned

- **Full equation-of-state flash, hydrate thermodynamics and sand transport.** These need large data sets or iterative solvers beyond the zero-dependency, single-file model. Keep the screening methods that exist and point users to specialist tools.
- **Cement job design** (friction pressures, ECD, temperature schedules). Outside the surface well-test scope.

---

## 2. PRiSM next steps

v1.5 closed the audit defects and delivered most of the earlier "NOW" packages:
- five-step shell;
- results rail;
- flow-period step;
- ▶ Analyse;
- sign-aware Δp;
- physical-unit regression with CIs;
- MDH/Horner/superposition;
- skin deliverables (ΔpS, FE, DR, J, rw′, p*) and skin decomposition;
- rate-dependent skin;
- decline EUR with P10/P50/P90;
- FMB and √t RTA plots;
- Tab 7 report;
- undo/redo;
- Tools drawer;
- 375 px layout.

The items below are what remains. Features are described generically.

### 2.1 NEXT (roughly 6–16 weeks)

| ID | Package | What it adds | Value | Effort | Dependencies | Status now |
|---|---|---|---|---|---|---|
| N1 | Model & fit workspace | Compare saved fits side by side (overlay plus table). Named analysis branches. Model browser with search and plain-language names. Drag-to-match overlay in physical units | H | M | C4 fit store, C8 persistence | Undo/redo and the rail are done. Compare and branches are open |
| N2 | Regression control | Choice of fit target (log-log vs history, period vs full test). Point weights and lasso exclusion. Live redraw with Stop. Staged presets (storage first, then skin, then boundaries). Global regression across several build-ups | H | M | N1; C2 periods | Weights exist in the engine; no UI. Global regression is open |
| N3 | Gas & deliverability | m(p) mounted end-to-end (PVT → Δm(p) → models → report). Pseudo-time in PTA as well as RTA. Material-balance-corrected pseudo-time. AOF and IPR inside PRiSM, reusing the `gasdeliv` / `oilipr` compute functions. Skin-vs-rate plot | H | M | Calculators #1 and #2, and `16-pvt.js` | Pseudo-time exists in RTA and rate-dependent skin exists. m(p) is only partly wired, and some tools still use liquid-equivalent Δp for gas (see CLAUDE.md known limitations) |
| N4 | Model gaps | Changing wellbore storage (two published forms). Trilinear flow, then uniform-flux multi-fractured horizontal wells. Time-dependent skin. Areal anisotropy across all models. Input-range validation | H | L | C3 physical model; the regression speed work in §3 (horizontal-family fits are slow) | Some anisotropy and changing-storage code exists. Trilinear and time-dependent skin are open |
| N5 | QA/QC & big data | Gauge-to-gauge difference with statistics. Clock sync and drift correction. Datum and gradient correction. Trend removal. Web-worker parsing. Raw vs analysis datasets in IndexedDB | H | M | §3 performance work | Hampel filter, decimation and IndexedDB storage exist. The rest is open |
| N6 | Sensitivity & test design | Parameter sweeps drawn as overlays. Monte-Carlo with re-regression in a worker pool. Goodness-of-fit threshold. Test design: forecast shut-in length to see the radial flow stabilisation and a boundary at a given distance, with a gauge-resolution check | H | M | N5 workers; R12 gauge register | Open |
| N7 | Report outputs | SVG and slide-deck export. Honest-precision wording (significant figures follow the CIs). LAS reader | M | M | §3 report templates | Tab 7 report and PDF/CSV exist |
| N8 | Decline analysis | Rate-only path with power-law and multi-segment declines. b(t) and D(t) diagnostic plots. Rate/cumulative weighting. Direct manipulation of the curve | M | M | `35-rta-dca.js` | D_lim, EUR, abandonment and probabilistic EUR exist |

Critic items that belong in NEXT:

| ID | Item | Value | Effort | Dependencies |
|---|---|---|---|---|
| R12 | Gauge register (serial, range, resolution, accuracy, calibration date, depth). Check expected semilog slope against gauge resolution. Flag late-time data below resolution | H | S | Tab 1 data manager |
| R13 | Sequence-of-events log (tool open/close, choke changes, sampling, gauge runs). Shown as markers, used to seed flow periods. Can be fed from the host calculators and the simulator | H | S | C2 periods |
| R15 | Total-compressibility builder: c_t = S_o·c_o + S_w·c_w + S_g·c_g + c_f, with a rock-compressibility correlation and a "defaulted" flag | H | S | C1 well store, 16-pvt |
| R16 | Locale and base conditions: decimal-comma files, day-first dates, time zones; one selectable standard-conditions setting applied to rates, m(p) and AOF | H | S | §3 P7 (global base conditions) |
| R19 | Parameter correlation matrix with identifiability warnings (e.g. C–S, distance–c_t); optional robust (Huber) regression | M | S | N2 |
| R18 | Input-uncertainty tornado for h, φ, c_t, μ, B, r_w, carried through to k, distances and r_inv | M | S | N6 |
| R4 | DST and closed-chamber recovery rates. Rate per flow period from drill-string pressure rise (capacity × dp/dt ÷ fluid gradient), reconciled with recovered volume. Standard DST sequence template | M–H | S | R13; the tubular table (calculator #5) |
| R14 | Measured sandface or downhole-flowmeter rate channel used in superposition. Rename the current "sandface convolution" option to "multi-rate superposition (equivalent time)" | M | S | C2 |
| R1 + R2 | Injection/falloff workflow. Two-zone composite with the front radius from cumulative injection. Separate injectate viscosity. Hall and derivative-Hall plots. A regulatory falloff report preset | M–H | M | N7, R12, R13 |
| R22 | Change log and audit trail: data edits, masks, period changes, fits; dataset hash on every result; "equations used" appendix; draft / reviewed / approved status | M–H | M | N1 undo stack, project file |
| R20 | Model verification suite: golden values against published tables and limiting forms, plus a second Laplace inverter to cross-check Stehfest | H | M | Acceptance-test harness |

### 2.2 LATER (roughly 4–12 months)

| ID | Package | What it adds | Value | Effort | Dependencies |
|---|---|---|---|---|---|
| L1 | Special tests | DFIT/minifrac: G-function, √t, after-closure analysis, tangent and compliance closure picks. Slug and DST. Closed-chamber. Step-rate. Impulse tests | H | L | R4, R13 |
| L2 | RTA suite | Normalised-rate type curves (Blasingame and Agarwal-Gardner families) with k, S and r_e from the match. Normalised pressure integral. Fetkovich type curves. p–q plot. Production-data QC card | H | L | N3, N8 |
| L3 | Advanced deconvolution | Common-initial-pressure variant. Late-part-only variant. Gas-depletion variant. Exposed controls and validity checks. Monte-Carlo uncertainty | M | M | N5, N6 |
| L4 | Permanent-gauge surveillance | Wavelet denoising. Automatic shut-in detection with confirmation. Skin vs time over many build-ups. PI vs time. Incremental re-analysis of new periods | M–H | L | N2 global regression, N5 |
| L5 | Collaboration & assistance | Read-only share viewer. Comment pins. Plain-language "explain this derivative shape". Drafted narrative. QC assistant | M | L | §3 P5 sharing, R23 privacy |
| L6 | Integration | Offset-well manager and map. Production-log rate multilayer regression. Documented JS API. "Send to rate history" from separator and orifice calculators. Industry-standard PRODML exchange | M | M | §3 P3 multi-well, R13 |
| L7 | Numerical models | Boundary-element or WebAssembly finite-volume models for polygon reservoirs, started from the analytical fit | M | L (8+ weeks) | N4, performance work |
| R21 | Wellsite supervision | Stream or append data. Live derivative, r_inv and "objective met?" readouts. "OK to end shut-in" advice tied to the test design | H for field crews | M | N5, N6 |
| R3 | Formation tester / mini-DST | Pretest mobility. Piston-volume rate history. Probe and dual-packer geometries. Vertical interference | M | M | R4, spherical models |
| R5–R11 | Specialist markets | Gas condensate (two-phase m(p), condensate-bank composite). Pressure-dependent k and φ. Coalbed methane (Langmuir). Unconventional flowback. Frac-hit interference. Areal pulse tests. Groundwater and aquifer tests | L–M each | M each | Case by case |
| R24 | Standard data exchange (PRODML well-test and PTA objects) | L–M | M | L6 |
| R23 | Privacy statement and analytics audit (no well data in analytics events). Encrypted project files as an option | H (trust) | S | Do first; a precondition for L5 |

**Sequencing notes.**
- N3 should follow calculators #1 and #2, so deliverability maths lives in one place.
- R12, R13, R15 and R16 are cheap credibility items. Put them early in NEXT.
- L1 (DFIT) is the most requested missing module in North American markets. Pull it forward if those users are the target.

---

## 3. Platform

| ID | Item | What it involves | Value | Effort | Dependencies |
|---|---|---|---|---|---|
| P1 | **Offline 3D on iOS** | The 3D view loads three.js r170 on demand from a CDN, verifies its SHA-384 and caches it in IndexedDB. A first launch offline therefore falls back to 2D. `32-wts-3d.js` already honours a `window.WTS3D_LOCAL_URL` override. Steps: bundle `three.module.min.js` (about 0.7 MB) in `ios-app/ios-additions/libs/`; copy it into `www/` in `sync-from-main.js`, next to the bundled PDF libraries; set the override in `ios-bridge.js`. Check that module import from a local or blob URL works in WKWebView, and keep the SHA-384 check | H | S | `sync-from-main.js`, `ios-bridge.js`; a Mac/Xcode run to verify |
| P2 | **Offline web app** | A service worker that caches the single HTML, bundled libraries and fonts, so the web build works on location without signal. Include an update prompt | H | S–M | Hosting headers. Must not cache user data |
| P3 | **Multi-well projects** | Projects hold a list of wells, each with its own namespace for page inputs, Client & Well info and PRiSM state. Adds a well switcher, copy inputs from another well, and a job-level comparison table (AOF, PI, skin, emissions per well) | H | M–L | `29-project-save.js`, page autosave keys, PRiSM C1/C8 stores |
| P4 | **Report templates** | Quick Report exists (per-page snapshots). Add templates, each a list of pages or sections with cover, headings and order; user templates saved in the project:<br>• daily well-test report (sequence of events, rates, cumulative volumes, flare emissions);<br>• final well-test report (test summary, deliverability or IPR, PTA results, emissions, safety checks);<br>• regulatory falloff report | H | M | Calculators #1–#4; R13 events log; host report engine |
| P5 | **Sharing and cloud sync** | Staged:<br>(a) a self-contained read-only HTML snapshot of a report or project, with no server (S);<br>(b) project files via the share sheet (exists on iOS) and the File System Access API on desktop (exists);<br>(c) optional cloud sync with accounts, read-only share links, revocation and audit (L).<br>Stage (c) needs a backend, encryption at rest and a written privacy position | M–H | S → L | R23 privacy; P3 multi-well |
| P6 | **Performance** | *Done in v1.7:* analytics page-view calls deferred to idle time (first render ≈ 1 ms instead of ≈ 60 ms); quota-safe storage writes with snapshot eviction and a warning. *Prepared, not applied:* logo de-duplication and downscale (−120 kB, −10 MB decoded bitmap). The host file is about 76k lines and the iOS bundle about 4.3 MB; PRiSM is 58 % and the 3D simulator 14 % of the script. Work items:<br>• initialise heavy modules (PRiSM, 3D, simulator) on first visit to their route, not at load;<br>• move regression, auto-match and big-file parsing into Web Workers built from inline source (no extra files);<br>• decimate plots everywhere;<br>• set a startup-time and bundle-size budget checked in CI | H | M | Smoke test (no timers left pending after 5 s idle) must stay green |
| P7 | **Global base conditions & units coverage** | One setting for standard conditions (60 °F / 14.696 psia, 60 °F / 14.65 psia, 15 °C / 101.325 kPa) used by every gas-volume calculation. Extend the units manifest to every Round-5 page (the v1.7 calculators tag their own inputs). Metric companions on key outputs (done for AGA-3 and dual choke in v1.7) | H | S–M | `22-units.js`; R16 |
| P8 | **Host calculator verification suite** | Golden-value tests for every host calculator, run by `accept-test.js`. *Largely done in v1.7:* the G1–G5 audit added page-level hand-calculation tests for every host calculator; the pure `*_compute` refactors remain | H | M | Refactor calculators into pure `*_compute` functions (the Round-5 pattern) |
| P9 | **Data import/export** | CSV paste/import for test-point tables (deliverability, IPR, proving). "Send to PRiSM rate history" from the separator, orifice and tank calculators. Export calculator results as CSV/JSON | M–H | S–M | P8 pure compute functions; R13 |
| P10 | **Accessibility & localisation** | Keyboard navigation, ARIA labels on table inputs, contrast checks. Decimal-comma input. Translated labels later | M | M | None |
| P11 | **Code health** | *Done in v1.7:* dead `renderDCA` / `renderPTA` bodies deleted (−38 kB). Move large host calculators into numbered source files using the existing concat/inject pipeline, so they can be tested in the headless harness | M | M | P8 |

---

## 4. Suggested release sequence

| Release | Contents |
|---|---|
| v1.7 — **DONE** | Calculators #1–#4 (`gasdeliv`, `oilipr`, `flareghg`, `h2sroe`) on the plug-in registry. G1–G5 calculator accuracy audit with regression tests. P6 quick wins (deferred analytics, quota-safe storage) and P11 dead-code removal. Release notes |
| v1.7.x | Carried over from the v1.7 plan: P1 offline 3D on iOS, R23 privacy statement. Logo de-duplication. Open audit points in §1.5 that need no domain decision |
| v1.8 | Calculators #6, #7, #5 (after the shared tubular table) and #8. P4 report templates (daily and final well-test). P7 base conditions. PRiSM R12, R13, R15, R16 and N3 (gas m(p) plus in-PRiSM deliverability using the #1/#2 compute functions) |
| v1.9 | Calculators #9, #10, #11 and #12. PRiSM N1, N2, N5 and R19. P6 performance (workers) and P8 verification suite |
| v2.0 | P3 multi-well projects and P5(a) read-only snapshots. PRiSM N6 test design, L1 special tests (DFIT), L2 RTA type curves |

---

## 5. Sources

Standards, regulations and papers referred to above.

**Regulations and guidance**
- Texas Administrative Code, 16 TAC §3.36 (Statewide Rule 36): hydrogen sulphide radius of exposure formulas, escape-rate basis (adjusted open flow, 14.65 psia and 60 °F), and the 50 ft / 3,000 ft thresholds. https://www.law.cornell.edu/regulations/texas/16-Tex-Admin-Code-SS-3-36
- Railroad Commission of Texas, *Section G: well status reports*. Deliverability and AOF within 90 days of completion; stabilised one-point tests of at least 72 hours. https://www.rrc.texas.gov/media/wjbhs4tp/section_g.pdf
- North Sea Transition Authority, *Flaring and venting guidance*, and the annual consents exercise. https://www.nstauthority.co.uk/regulatory-information/licensing-and-consents/consents/flaring-and-venting/
- Commission Implementing Regulation (EU) 2018/2066, Annex IV §1.D (as retained in the UK ETS): flare Tier 1 reference factor of 0.00393 t CO2/Nm³ (ethane proxy); oxidation-factor tiers for flares. https://www.legislation.gov.uk/eur/2018/2066/annex/IV
- US 40 CFR Part 98 Subpart W, §98.233(n) and (v): flare CO2/CH4/N2O method, default combustion efficiency 0.98, gas densities at 60 °F and 14.7 psia.
- Kansas K.A.R. 82-3-303: an assigned back-pressure slope of 0.85 for low-rate wells. https://www.law.cornell.edu/regulations/kansas/K-A-R-82-3-303

**Industry standards**
- API RP 14E (erosional velocity).
- API RP 44 (reservoir fluid sampling).
- API RP 49 / RP 55 (H2S safety).
- API Std 520/521.
- API MPMS Ch. 4, 5.3, 11.1, 12.2 and 14.3 (AGA-3).
- GPA 2145 (physical constants, heating values).
- IPCC AR4/AR5/AR6 global warming potentials.

**Technical papers**
- Rawlins & Schellhardt (1935), USBM Monograph 7 (back-pressure equation).
- Houpeurt (1959) (LIT form).
- Vogel (1968), JPT.
- Standing (1970), JPT (flow efficiency).
- Fetkovich (1973), SPE 4529.
- Beggs & Brill (1973), JPT.
- Payne et al. (1979).
- Briggs (1973) (dispersion coefficients).
- Oddo & Tomson (1994) (scale prediction).
- Salama (2000) (sand erosion).
