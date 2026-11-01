# Chemical Injection module — implementation plan

> **Status (2026-10-31):** plan only — no code yet. Prerequisite “fix the failing acceptance test, merge 3.1.1” is done: v3.1.1 is on master (a35206f) with 853/853 acceptance and 311/311 smoke (the single failure did not reproduce). Open decisions Q1, Q2, Q5, Q17, Q18 and Q19 must be answered before 3.2a starts.

| | |
|---|---|
| Status | Plan for review, revision 2: review round 1 applied (48 issues, see Appendix A). No repo changes made |
| Date | 2026-10-31 |
| Target release | v3.2 in two gated increments (3.2a, then 3.2b) → v3.3 (Phase 2) → later (v2 items) |
| Route key / id prefix | `cheminj` / `cj_` |
| Files | `prism-build/40-calc-chemlib.js` (data), `prism-build/49-calc-cheminj.js` (page + engine), three additive exports in `prism-build/46-calc-gaspvt.js` (`WTS_gaspvt_z`, `WTS_gaspvt_enthalpy`, `WTS_gaspvt_isenthalpic`) |
| Sidebar | Recommended for 3.2a: `cheminj` as the 8th row of Test System Safety (no hub change). Alternative: a hub titled "Hydrate, H2S & Chemicals". This is user decision Q1 and must be taken before any code |
| Inputs to this plan | Four research workstreams (hydrate, H2S and other chemicals, pumps, codebase audit) and two independent reviews. The numbers in this revision were re-run in `rev_jt.js` (J-T solver prototype and validation) and `rev_calc.js` (every worked example), in the same scratchpad folder as the earlier `plan_calc*.js` |

**Conventions.** Field units come first (bbl/d, gal, psi, °F, MMscf/d, ppm), with metric in brackets. "gal" means US gallon. Pressures are psig unless marked psia. Confidence tags: **[H]** high, **[M]** medium, **[L]** low. Every chemical and pump is named by its generic chemistry or type only. No company, supplier, brand or product names appear.

---

## 0. Decisions at a glance

| # | Decision | Default / choice | Why |
|---|---|---|---|
| D1 | One planner page for every injection line on a surface well-test spread | 1–6 lines, chosen with one "Number of injection lines" select | A typical test runs methanol (upstream of the choke and/or downhole), scavenger, corrosion inhibitor, demulsifier and antifoam |
| D2 | Reuse the existing engines; never re-implement them | `WTS_hydrate_temp`, `WTS_hammerschmidt_*` (through an explicit key map, §4.3), `WTS_h2s_scavenger`/`_so2`, `WTS_gaspvt_*`, `WTS_gradient_compute`, `WTS_flowline_friction`, `WTS_tubulars` | CLAUDE.md shared-engines rule |
| D3 | Choke outlet temperature is a real-gas isenthalpic calculation with the J-T cooling multiplied by a design factor | DAK departure functions in 46-calc-gaspvt.js; J-T cooling × f_JT, default **1.10** (editable 1.00–1.30). The 7 °F/100 psi rule stays as a labelled option | DAK under-predicts methane μJT by up to 9 % against the NIST reference (§4.1.3). H1: rule −30 °F, DAK 41.4 °F, design 34.6 °F, Peng–Robinson check 35.8 °F |
| D4 | Water to treat = free water + water condensed from the gas + water carried in by aqueous chemicals upstream of the controlling node | Bukacek with Wagner–Pruss p_v; `water` fraction on every chemical record | Condensed water is 30 % of H1's water. An S1-size triazine line adds 172 lb/d of water (+16 %) |
| D5 | Methanol vapour loss uses a K-value correlation, not a flat +30 % | Moshfeghian (2011) "K-value express" | In H1 the loss is 39 % of the total |
| D6 | Depression method | W = max(Hammerschmidt, Nielsen–Bucklin) for methanol, ethanol and MEG; Hammerschmidt is always shown for reference. DEG/TEG: Hammerschmidt only, with ⚠ | Hammerschmidt is the less conservative of the two below 25 wt %; a method switch also made a 1.9 wt % step in the dose |
| D7 | Margin and sour gas | 10 °F (5.6 °C) with the gas-gravity correlation; 5 °F allowed with a user or lab T_hyd. Sour adder 5 °F per mol % H2S from 1 to 3 mol %; above 3 mol % H2S the correlation dose is refused unless a user T_hyd is entered | The correlation is good to about ±5 °F; H2S raises T_hyd strongly |
| D8 | Scavenger dose comes from chemistry, not a typed gal/lb | gal/lb = stoichiometric ratio ÷ (active × density) ÷ utilisation η | Utilisation and contact time are the real-world limits |
| D9 | Pump output | Plunger pumps → SPM. Metering pumps → % stroke × % speed. Air-driven liquid pump → air pressure setting and cycles/min. Always also gal/d, L/h, mL/min | The request is for strokes/min or volume/min, depending on the pump |
| D10 | Pressure design basis | Required pressure P_req from the operating case (shut-in for downhole and upstream-of-choke points). Rating ≥ max(1.10·P_req, P_req + 100 psi, 1.10·P_back, P_back + 100 psi), where P_back = SITHP for wellbore-connected points and the tie-in MAWP elsewhere (default: separator PSV set). The PSV is never set below P_back | A leaking check valve exposes the discharge circuit to the process; the pump must also inject before the well is opened |
| D11 | Sidebar placement | Q1 (user decision before code). Recommended: 8th row of Test System Safety | Fluids & Utilities is at the 8-row limit; `tests/sidebar-nav.test.js` calls the hubs "the agreed structure" |
| D12 | Existing `chem` page | Keep it (route, data, tests); add a one-line cross-link. Its ppm formula becomes the `ppmv_liq` basis here (identity test) | Saved data and tests depend on the route |
| D13 | Hazardous area and pump choice | Pumps are ranked by hazardous-area suitability first (pneumatic and air-driven pumps before electric in a classified area). H1 default pump: air-driven liquid pump. The electric plunger pump is the listed alternative, with a "certified motor" ⚠ | No pneumatic plunger pump can do H1; the air-driven pump is the common high-pressure methanol pump on surface tests |
| D14 | Pneumatic drive gas | Instrument air or nitrogen by default. Produced sour gas as drive gas → ✗ | Each pump vents its drive gas at the pump |
| D15 | Delivery | 3.2a, then 3.2b, each with its own gates. Prerequisites first (§9.1) | The single 13–15-day MVP was too large |
| D16 | Decide before code | Q1 (sidebar), Q2 (Hydrate-page banner), Q5 (margin), Q17 (J-T factor), Q18 (sour limit), Q19 (default pump) | Each changes markup, tests or headline numbers |

---

## 1. Goal and scope

### 1.1 What the module does for a well-test crew

For a planned or running surface well test, the module answers six questions for each chemical:

1. **Where to inject.** Downhole (capillary or chemical injection valve (CIV), or the subsea-test-tree port), flowhead/upstream of the choke, downstream of the choke/heater inlet, heater outlet/separator inlet, separator gas outlet (upstream of the back-pressure valve or meter), flare line, separator oil outlet, separator water outlet, tank. It works out the conditions at that point and whether the chemical belongs there.
2. **How much.** For hydrates, a rigorous design: J-T cooling, hydrate temperature, depression, condensed water and water from other chemicals, vapour and condensate losses, lean strength. For H2S, mass removal, stoichiometry, utilisation and contact time. For everything else, a dose basis (ppm on oil, water or total liquid, pt/MMscf, vol % of water…).
3. **Which pump and what setting.** Strokes/min for a chosen plunger × stroke × heads, % stroke × % speed for a metering pump, or the air pressure for an air-driven liquid pump. It flags settings outside the controllable band and suggests the next plunger or pump, ranked by hazardous-area suitability.
4. **What pressure.** The discharge pressure needed at that point (with downhole hydrostatic, capillary friction, CIV set pressure and the siphon check), the rating the discharge circuit needs against the maximum credible back-pressure, and the PSV setting band.
5. **How to check it in the field.** Expected mL in a 30 s / 60 s drawdown-cylinder test, seconds per stroke, strokes per 15 s, and corrected settings from a measured calibration.
6. **Logistics.** Days of supply per tank, chemical volume for the test, totes and tote changes, batch volumes for start-up fill or shut-in, and pneumatic drive-gas use.

It also screens the whole spread:
- the hydrate risk at every node (flowing, shut-in and cold start-up);
- the second expansion at the separator gas outlet;
- sour-service partial pressure;
- flare SO2 avoided;
- incompatible chemical pairs;
- backflow to the chemical tank, thermal relief of blocked-in lines, sour drive gas and oxidiser hazards.

### 1.2 Users

Well-test supervisor, chemical-injection operator, planning/flow-assurance engineer. The output feeds the job programme and the daily/final report (PDF, PNG, Quick Report).

### 1.3 Out of scope (all phases unless noted)

- Composition-based hydrate prediction (van der Waals–Platteeuw / cubic-plus-association). A user T_hyd override takes its place.
- Corrosion-rate prediction (e.g. de Waard–Milliams). Corrosion-inhibitor dosing is basis-driven only; a rate model is a v2 candidate.
- Scale saturation. That exists in `49-calc-scale.js`; Phase 3 adds a link ("SI > 0 → recommend scale inhibitor").
- Product selection, costing, procurement, and environmental discharge permitting.
- Solid-bed scavenger vessel sizing (iron oxide), caustic scrubbers, molecular sieves.
- Mercaptan dosing. Mercaptans get an information line only.
- Closed-loop pump control.
- Simulator integration (Round-7 workstream; see §9.6).
- Detailed transient thermal modelling of landing strings or risers. The user enters T at the injection depth.
- Relief-valve sizing. The module gives set-pressure bands and requirements, not orifice sizes.

---

## 2. User workflow and UI

### 2.1 Workflow

1. **Stream.** Gas rate, gravity, H2S/CO2/N2, oil/condensate and water.
2. **Spread.** SITHP, FWHP, FWHT, ambient, choke downstream pressure, heater outlet T, separator pressure and its PSV set, flowhead pressure class, hazardous-area and drive-gas selections, pipe lengths/IDs for contact time, and downhole data if used.
3. **Design basis.** Margin, J-T factor, T_hyd source, depression method, condensed-water option, H2S target, pressure-margin policy and rating basis, test duration.
4. **Injection lines.** Choose how many lines (1–6). For each line choose the **point**, then the **chemical** (the list is grouped by purpose; the point is never changed by the chemical, and its suitability shows as a ✓/⚠/✗ verdict), the dose (preset from the chemical, editable), the **pump type** and its settings (plunger, stroke and heads, or capacity, or air-pump data). Rare fields sit behind a per-line **Advanced** toggle.
5. **Read the results.** Design basis, spread hydrate table, H2S block, one result box per line, a summary table, verdicts, two charts and the Notes boxes.
6. **In the field.** Calibration card: enter the measured mL and seconds and get the actual rate, ηv and the corrected SPM, speed or air setting. Tank and batch card.
7. **Report.** PDF/PNG and the Quick Report snapshot work automatically from the classes used (§6.6).

### 2.2 Page layout (desktop, one scrolling page, no tabs)

Tabs are avoided on purpose: `collectPageReport` skips hidden elements (host `_isShown`, L2441), so an inactive tab would vanish from PDFs and the Quick Report. Hidden advanced fields are therefore echoed in a results "Design basis" box.

```
#pgTitle  Chemical Injection
#pgSub    Hydrate inhibitor, H2S scavenger and treating-chemical dosing per injection point, with pump settings
<div id="cj_root">
 <nav class="cj-jump rp-skip">  Stream · Spread · Basis · Lines · Results · Charts · Notes  (anchor links)
 ┌ Card 1 Well stream ───────────────┐ ┌ Card 2 Spread conditions ─────────────────┐
 │ qg, γ, H2S ppm, CO2, N2           │ │ SITHP FWHP FWHT Tamb  Pck  J-T method     │
 │ qo, API, qw, SGw, water basis     │ │ heater? Thtr  Psep Tsep  Pbpv(dn)         │
 │ H2S in oil/water (ppmw)           │ │ separator PSV set, flowhead class         │
 └───────────────────────────────────┘ │ pumps in classified area?  drive gas      │
                                       │ contact-time pipe: 4 × (length, ID)       │
                                       │ Downhole (shown when a line is downhole)  │
                                       └───────────────────────────────────────────┘
 ┌ Card 3 Design basis ─────────────────────────────────────────────────────────────┐
 │ margin  J-T factor  T_hyd source (+override)  method  condensed water            │
 │ H2S target (+custom / SO2 allow + CE)  pressure margin %/psi  rating basis       │
 │ test duration  drive-gas pressure  contact-time requirement   [Advanced ▸]       │
 └──────────────────────────────────────────────────────────────────────────────────┘
 ┌ Card 4 Injection lines:  Number of lines [1 ▾] ──────────────────────────────────┐
 ┌ Card 5…10 Injection line n   (whole card hidden when n > number of lines) ───────┐
 │ <span class="cj-chip rp-skip"> Methanol · Upstream of choke · 160.0 gal/d · air 45.6 psig
 │ point ▾  chemical ▾  dose basis  dose  lean % (THI) / active %, SG, η (scavenger) │
 │ pump type ▾ + the fields of that pump kind only   tank volume   [Advanced ▸]     │
 └──────────────────────────────────────────────────────────────────────────────────┘
 ┌ Card 11 Field calibration check ──┐ ┌ Card 12 Start-up fill / batch (3.2b) ──────┐
 │ line ▾  measured mL  seconds      │ │ fill to ▾ (Card 2 segments)  tree volume   │
 │ setting during test               │ │ line ▾                                     │
 └───────────────────────────────────┘ └────────────────────────────────────────────┘
 <div id="cj_res" data-done="1">
   ⚠ top-line disclaimer (verdict div)
   .rbox "Design basis"              (.rrow echo of margin, f_JT, methods, hidden advanced values)
   .rbox "Spread hydrate check (margin 10 °F, J-T × 1.10)"  (table.dtable nodes + .rrow + verdicts)
   .rbox "H2S and scavenging"        (.rrow + verdicts)  [3.2b; only if H2S > 0 or a scavenger line]
   .rbox "Line n — <chemical> at <point>"   one per active line
        Rates · Pump setting · Discharge pressure · Field check · Supply · verdicts
        table.dtable "Pump options" (top 3 feasible + current)
   .rbox "Summary"                   table.dtable all lines + compatibility, backflow, thermal-relief verdicts
   .chart-wrap canvas#cj_chart_hyd   Hydrate curve vs spread temperatures
   .chart-wrap canvas#cj_chart_pump  Pump rate vs setting for line ▾ (cj_chart_line)
   six flat <div><b>Notes</b> …</div> boxes, each ≤ 600 characters (§8.1)
 </div>
</div>
```

### 2.3 Inputs (ids, units, defaults, ranges, unit category)

Defaults reproduce worked example H1 (hydrate, §4.13) so that the page opens on a validated case. Units categories marked * are new (§6.5). "untagged" means natively neutral or SI-explicit. A ΔP field uses the `pressure` category (gauge suffix must not appear on a difference).

**Card 1 — Well stream**

| id | Label | Unit (field / metric) | Default | Valid range | Category |
|---|---|---|---|---|---|
| `cj_qg` | Gas rate | MMscf/d (10³ m³/d) | 10 | 0–500 (0 allowed for liquid-only points) | gasRate |
| `cj_sg` | Gas gravity (air = 1) | – | 0.65 | 0.55–1.0 for T_hyd (⚠ above 1.0, raised by cheminj because `WTS_hydrate_temp` clamps silently); ≤ 3 for PVT | sg |
| `cj_h2s` | H2S in gas | ppm mol | 0 | 0–100,000. > 1,000 ppm → sour adder; > 30,000 ppm (3 mol %) → correlation dose refused unless user T_hyd | concentration |
| `cj_co2` | CO2 | mol % | 0 | 0–50 (> 5 → flat sour adder; > 20 → ✗ needs a composition-based T_hyd) | percent |
| `cj_n2` | N2 | mol % | 0 | 0–50 | percent |
| `cj_qo` | Oil / condensate rate | bbl/d (m³/d) | 0 | 0–100,000 | liquidRate |
| `cj_api` | Oil / condensate gravity | °API | 50 | 10–90 | api |
| `cj_qw` | Water rate | bbl/d (m³/d) | 2 | 0–100,000 | liquidRate |
| `cj_sgw` | Water SG | – | 1.05 | 1.00–1.25 | sg |
| `cj_wbasis` | Water rate is… | select | `free` = free (formation) water at wellhead; `sep` = measured at separator (already includes water condensed down to separator conditions) | – | untagged |
| `cj_h2so` | H2S dissolved in oil (3.2b) | ppmw | 0 | 0–10,000 | concentration |
| `cj_h2sw` | H2S dissolved in water (3.2b) | ppmw | 0 | 0–10,000 | concentration |

Phase 2 import buttons (not in the MVP markup):
- **Use simulator line-up** reads the versioned `WTS_state.flow` (check `v === 1`): `wellheadPressure`, `wellheadTemp`, `choke.{Pin, Pout, dTjt}`, `heater.{Tin, Tout}`, `separatorPressure`, `gasRate`, `waterRate`, `inputs.SGg` (host L100599-100613). Node labels are not matched.
- **Use H2S page** reads `WTS_state.h2sroe` first and falls back to `wts_page_h2sroe` (`hs_sq`, `hs_sin`, `hs_sout`), whose values are stored canonical imperial (host `__ctrlValue`, L1070-1083).

Both write inside `WTS_units.runCanonical` and then dispatch input + change, as `WTS_h2sUseAOF` does (44-calc-h2sroe.js L342-360).

**Card 2 — Spread conditions**

| id | Label | Unit | Default | Range | Category |
|---|---|---|---|---|---|
| `cj_sithp` | Shut-in tubing head pressure (SITHP) | psig (kPa(g)) | 3500 | 0–20,000 | pressureG |
| `cj_fwhp` | Flowing wellhead pressure (FWHP) | psig | 3000 | 0–20,000, ≤ SITHP warn | pressureG |
| `cj_fwht` | Flowing wellhead temperature (FWHT) | °F (°C) | 110 | −40–400 | temperature |
| `cj_tamb` | Ambient / cold-tree temperature (shut-in and start-up cases; chemical tank temperature) | °F | 60 | −60–130 | temperature |
| `cj_pck` | Pressure downstream of choke | psig | 1000 | 0 – FWHP | pressureG |
| `cj_jt` | Choke outlet temperature from | select | `ise` isenthalpic real gas × J-T factor (default); `rule` 7 °F per 100 psi (quick check: overstates cooling for drops starting above ~2000 psi, may understate it below ~1000 psi and 40 °F); `user` | – | untagged |
| `cj_tck` | Choke outlet temperature (user) | °F | 34.6 (shown only for `user`) | −60–400 | temperature |
| `cj_htr` | Heater on the spread | select | `yes` / `no` | – | untagged |
| `cj_thtr` | Heater outlet temperature | °F | 90 | −40–400 | temperature |
| `cj_psep` | Separator pressure | psig | 1000 | 0 – Pck | pressureG |
| `cj_tsep` | Separator temperature (blank = heater outlet, or choke outlet when there is no heater) | °F | blank | −60–400 | temperature |
| `cj_psvsep` | Separator PSV set pressure = MAWP of the choke-to-separator section (P_back for points downstream of the choke) | psig | 1440 | ≥ Psep | pressureG |
| `cj_whclass` | Flowhead / data-header pressure class | select | 2000 / 3000 / **5000** / 10000 / 15000 psi | ✗ if SITHP > class | untagged |
| `cj_haz` | Chemical pumps sit in a classified (hazardous) area | select | **yes** / no | – | untagged |
| `cj_supgas` | Pneumatic / air-pump drive gas | select | **`air`** instrument air; `n2` nitrogen; `sweet` sweet fuel gas; `well` produced well gas | – | untagged |
| `cj_pbpv` | Gas outlet pressure downstream of the back-pressure valve or meter (blank = no check; 3.2b) | psig | blank | 0 – Psep | pressureG |
| `cj_len_1…4`, `cj_id_1…4` | Pipe segments (contact time and batch fill): flowhead→choke, choke→heater inlet, heater coil, heater→separator | ft (m); in (mm) | 20/2.9, 60/3.826, 200/2.9, 80/3.826 | 0–5000 ft; 0.5–12 in | length; lengthSmall |

Downhole fields (3.2b; shown only while a line injects at `dh`):

| id | Label | Unit | Default | Range | Category |
|---|---|---|---|---|---|
| `cj_dh_tvd`, `cj_dh_md` | Injection depth TVD / MD | ft (m) | 8000 / 8500 | 0–30,000; MD ≥ TVD | length |
| `cj_dh_tub` | Tubing (for velocity and pill volume) | select from `WTS_tubulars` | 3-1/2 in 9.3 lb/ft (ID 2.992) | – | untagged |
| `cj_dh_ptub` | Flowing tubing pressure at injection depth | psig | 2800 | 0–25,000 | pressureG |
| `cj_dh_ptubmin` | Minimum tubing pressure at depth (siphon check) | psig | 1500 | 0–25,000 | pressureG |
| `cj_dh_ggrad` | Shut-in gas gradient override (blank = gas column from `WTS_gradient_compute`) | psi/ft (kPa/m) | blank | 0.02–0.2 | pressureGradient* |
| `cj_dh_tciv` | Temperature at injection depth | °F | 180 | −40–400 | temperature |
| `cj_dh_civ` | CIV opening (set) pressure | psi (kPa) | 1500 | 0–10,000 | pressure (ΔP) |
| `cj_dh_cap` | Capillary / control line | select | `c250_035` 1/4 × 0.035 in (ID 0.180), `c250_049` 1/4 × 0.049 (ID 0.152, default), `c375_049` 3/8 × 0.049 (ID 0.277), `c375_065` 3/8 × 0.065 (ID 0.245), `custom` | – | untagged |
| `cj_dh_capid` | Custom capillary ID | in (mm) | 0.152 | 0.05–1.0 | lengthSmall |

**Card 3 — Design basis**

| id | Label | Unit | Default | Range | Category |
|---|---|---|---|---|---|
| `cj_margin` | Hydrate design margin | °F (°C) | 10 | 0–30 (⚠ < 5; ⚠ < 10 with correlation T_hyd) | tempDelta |
| `cj_fjt` | J-T cooling design factor | – | 1.10 | 1.00–1.30 (⚠ below 1.10 until the validation in §7.1 V1–V2 passes) | untagged |
| `cj_thsrc` | Hydrate temperature from | select | `tm` gas-gravity correlation (Towler–Mokhatab); `user` user / lab value at one pressure | – | untagged |
| `cj_thuser`, `cj_thuserp` | User T_hyd at pressure | °F at psig | blank | −40–100 °F | temperature, pressureG |
| `cj_method` | Depression method | select | `auto` = larger of Hammerschmidt and Nielsen–Bucklin; `ham`, `nb` forced (comparison only, ⚠) | – | untagged |
| `cj_cond` | Condensed water | select | `buk` Bukacek water content (default); `all` all vapour water condenses at the cold node (conservative) | – | untagged |
| `cj_h2stgt` | H2S outlet target (3.2b) | select | `s4` 4 ppm (0.25 gr/100 scf sales-gas type), `mg5` 5 mg/m³ (3.47 ppm at the 15 °C base; computed from the active base conditions), `p10` 10 ppm, `p1` 1 ppm, `so2` from a flare SO2 limit, `custom` | – | untagged |
| `cj_h2scus` | Custom target (3.2b) | ppm | 4 | 0 – inlet | concentration |
| `cj_so2lim`, `cj_ce` | Allowable flare SO2; combustion efficiency (3.2b) | lb/h (kg/h); % | 10; 98 | 0.01–10,000; 50–100 | massRate; percent |
| `cj_pmpct`, `cj_pmabs` | Pump pressure margin | %; psi (kPa) | 10; 100 | 0–50; 0–1000 | percent; pressure (ΔP) |
| `cj_ratebasis` | Discharge-circuit rating basis | select | `credible` max credible back-pressure (SITHP or tie-in MAWP, default); `class` full tie-in class (`cj_whclass` / `cj_psvsep`) | – | untagged |
| `cj_days` | Test duration | d | 5 | 0.1–90 | untagged (days) |
| `cj_psup` | Drive-gas (air) pressure available | psig | 100 | 10–150 | pressureG |
| `cj_tcreq` | Scavenger contact-time requirement (3.2b) | s | 15 | 0–120 | untagged |
| `cj_adv_basis` | Show advanced design basis | checkbox (aria-label "Show advanced design basis") | off | – | – |
| `cj_fc` (adv.) | Methanol loss to condensate at 30 wt % / 40 °F | lb/bbl (kg/m³) | 0.25 | 0–2 | lbPerBbl* |
| `cj_glyloss` (adv.) | Glycol loss allowance | % | 1 | 0–10 | percent |
| `cj_sour` (adv.) | Sour adder per mol % H2S (1–3 mol %), and flat adder for CO2 > 5 mol % | °F | 5 | 0–20 | tempDelta |
| `cj_band_g`, `cj_band_a` (adv.) | Setting bands: green up to / amber up to (% of max) | % | 70 / 85 | 50–95 | percent |
| `cj_minf` (adv.) | Minimum-rate factor (turndown check) | – | 0.5 | 0.1–1 | ratio |

**Card 4 — Injection lines:** `cj_nlines` select 1–6 (default 1). Line cards with n > `cj_nlines` are hidden as whole cards, so they never reach reports. Each control has an `aria-label` (a11y.test.js L60-84 sweeps every route, hidden controls included).

**Cards 5–10 — Injection line n (n = 1…6).** Line 1 default: methanol upstream of the choke on the air-driven liquid pump (H1).

| id | Label | Unit | Default (line 1) | Notes |
|---|---|---|---|---|
| `cj_pt_n` | Injection point | select (§3) | `wh` | static list of 9 points; never changed by code |
| `cj_chem_n` | Chemical | select (§5.1, `<optgroup>` per purpose) | `meoh` | values are `WTS_chemlib` keys |
| `cj_basis_n` | Dose basis | select | preset from chemical (`wt_water` for THI) | label says "product (as supplied)" for ppm bases |
| `cj_dose_n` | Dose | basis unit (untagged) | blank = "from hydrate design" for THI; DB default otherwise | THI: optional rich wt % override |
| `cj_lean_n` | Lean (as-injected) strength | wt % | 100 (MeOH), 80 (MEG) | THI only |
| `cj_sgc_n`, `cj_eff_n` | Product SG, utilisation η | –, – | from DB / point | η for scavengers |
| `cj_pump_n` | Pump type | select (§5.2) | `air_liquid` | |
| `cj_plg_n` | Plunger | select: 3/16, 1/4, 5/16, 3/8, 1/2, 5/8, 3/4, 7/8, 1, 1-1/4 in (mm shown) | 7/8 in | plunger pumps only |
| `cj_stk_n` | Stroke length | select: 1/4, 1/2, 3/4, 1, 1-1/4, 1-1/2, 2 in | 1 in | plunger pumps only (max stroke for electric) |
| `cj_heads_n` | Heads (pneumatic: plungers on one actuator) | select 1 / 2 / 3 | 1 | plunger pumps only |
| `cj_qrated_n`, `cj_pmax_n` | Rated capacity; max discharge pressure | gal/h (L/h); psig | from preset | metering diaphragm only; chemRateHr*, pressureG |
| `cj_q0_n`, `cj_ratio_n`, `cj_vcyc_n` | Free-flow rate; pressure ratio; displacement per cycle | gal/h; –; in³ (mL) | 30 (0.5 gpm); 100; 1.0 | air-driven liquid pump only; chemRateHr*, untagged, volPerStroke* |
| `cj_tank_n` | Chemical tank usable volume | gal (L) | 275 | volumeSmall |
| `cj_adv_n` | Advanced | checkbox (aria-label "Line n advanced settings") | off | shows the fields below |
| `cj_act_n`, `cj_wat_n` (adv.) | Active %; water % of the product | %, % | from DB | scavengers, aqueous products |
| `cj_peak_n` (adv.) | Peak / start-up factor | – | 2.0 THI, 1.5 scavenger, 1.25 others | used for the pump check |
| `cj_ve_n` (adv.) | Volumetric efficiency ηv | – | 0.90 (blank → auto model §4.10.2) | 0.5–1.0 |
| `cj_spmmax_n` (adv.) | Max SPM (pneumatic) / crank SPM (electric plunger) | SPM | from preset (60 / 120) | per nameplate |
| `cj_actd_n` (adv.) | Pneumatic actuator diameter | select 4 / 6 / 8 in (mm shown) | 4 | pneumatic only |
| `cj_rod_n` (adv.) | Electric plunger frame rod load | lbf (N) | 2500 | force |
| `cj_dpq_n` (adv.) | Quill / nozzle + check-valve allowance | psi (kPa) | 50 | 0–1000; pressure (ΔP) |
| `cj_mawp_n` (adv.) | Lowest MAWP in the discharge circuit (blank = pump rating) | psig | blank | pressureG |

**Card 11 — Field calibration check:** `cj_cal_line` (1–6), `cj_cal_ml` measured mL (untagged, SI), `cj_cal_s` seconds, `cj_cal_set` the SPM, speed % or air psig during the test.

**Card 12 — Start-up fill / batch (3.2b):** `cj_b_seg` select "Fill to" (choke = segment 1; heater inlet = 1–2; heater outlet = 1–3; separator = 1–4), `cj_b_tree` tree, flowhead and manifold volume (gal; volumeSmall; default 10), `cj_b_line` (which line's chemical). The downhole pill uses the downhole tubing and MD. The hand-pump displacement is Phase 2.

**Chart selector:** `cj_chart_line` (1–6).

**Size.** About 200 persisted controls in total, but about 60 are visible on first open (one line, no downhole, advanced closed), and each extra line adds about 13.

### 2.4 Dropdown behaviour (restore-safe)

- **All lists are static `<select>` markup.** That keeps them restore-safe. The GUI sweep tries every option, so every option must compute finite values.
- **The injection point is never preset or changed by code.** The point the chemical prefers is shown as the ✓/⚠/✗ suitability verdict (§3.3).
- **A chemical change presets only chemical-property fields:** basis, dose, lean %, active %, water %, SG, η, peak factor. It does so only when the chemical value actually changed: the previous key is kept in `data-prev`, and nothing is preset from other fields. The preset runs inside the `#pgBody` input/change event, which the units layer runs in a canonical context, so the written values are imperial and display correctly in Metric (test: Metric mode, change chemical, the tank field shows 1041 L, not 275).
- **Restore** uses registry `hooks.silent` (§6.9): values are applied without events, then `hooks.after` re-syncs `data-prev`, the show/hide state (line count, pump kind, advanced, downhole) and runs one calc.
- **Pump-type change** shows only the fields of that pump kind (plunger: plunger/stroke/heads; metering: capacity/P_max; air-driven: Q₀/ratio/displacement) and presets its numbers through the same `data-prev` rule.
- **Option labels show both units** (e.g. "3/8 in (9.5 mm)", "1/4 × 0.049 in capillary (ID 3.86 mm)") so selects need no unit tagging.

### 2.5 Results (what each block shows)

**Top line:** the ⚠ planning disclaimer (§8.1), a verdict div under 300 characters.

**Design basis (`.rbox`)** — echoes what the report would otherwise miss: margin (and sour adder), J-T method and factor, T_hyd source, depression method, condensed-water option, rating basis and margins, P_back per point type, hazardous-area and drive-gas choices, and every advanced value that is hidden.

**Spread hydrate check (`.rbox`, title states the margin and J-T factor)**
- **Node table** (`table.dtable`). Rows: Downhole (if used), Flowhead (flowing), Downstream of choke, Heater outlet / separator inlet, Separator gas after back-pressure valve (if `cj_pbpv`), Shut-in: flowhead (SITHP, T_amb), Start-up: downstream of choke. Columns: P, T (design), T_hyd, subcooling (T_hyd − T), status (✓ no risk / ⚠ within margin / ✗ hydrate region).
- **Rows:** controlling node; required depression ΔT; rich concentration X_R (method and the Hammerschmidt reference value); water to treat (free + condensed + from other chemicals); inhibitor (aqueous, vapour loss, condensate loss, total, lb/d and kg/d); rich-phase freeze point; LDHI screening line (3.2b); start-up and shut-in requirement (wt %).
- **Verdicts:** §8.2. Each hydrate verdict states the margin used.

**H2S and scavenging (`.rbox`, 3.2b)**
- H2S in gas (lb/d, kg/d) and in liquids;
- partial pressure at FWHP and the sour-service note;
- outlet target (ppm and its base);
- scavenger demand;
- contact time from each candidate point to the separator;
- SO2 at the flare before and after treatment (`WTS_h2s_so2` twice) and SO2 avoided = before − after;
- radius of exposure "always on untreated gas — see H2S page", with a link.

**Line n result box (`.rbox`)**
- **Rates:** gal/d · L/d · L/h · mL/min · bbl/d · gal/MMscf (gas-basis chemicals) · achieved concentration.
- **Pump setting:**
  - plunger pumps: SPM (design, peak, minimum), % of max with band colour, seconds/stroke, strokes per 15 s, mL/stroke swept and delivered (× ηv);
  - metering pumps: recommended % stroke × % speed, pulse rate, mL/stroke, with one alternative;
  - air-driven liquid pump: air pressure setting (design and peak), flow at the required pressure at full air, cycles/min (field count), stall pressure at the design setting, and "set and verify by drawdown cylinder or meter (mandatory)".
- **Discharge pressure:** line pressure basis + allowance + friction − hydrostatic + CIV = required; P_back; minimum rating; pump capability; PSV set band; hydraulic power at P_req (electric).
- **Blocked-in pressure rise:** ≈ α/β psi per °F for the chemical (methanol 77 psi/°F; 2,300 psi for a 30 °F rise).
- **Field check:** expected mL in 30 s / 60 s, time per 100 mL, minimum calibration-cylinder size.
- **Supply:** days per tank, gal for the test (+20 % contingency), totes on site and tote changes; drive-gas use (and the regulatory default when the drive gas is natural gas).
- **Verdicts** (§8.2) and a **"Pump options"** `table.dtable`: the top 3 feasible options ranked as in §4.10.6, plus the current choice.

**Summary (`.rbox`)**
- `table.dtable` of all active lines: point, chemical, gal/d, mL/min, pump and setting, required P, rating, verdict.
- Total chemical inventory per chemical.
- Compatibility verdicts (§5.4), the backflow verdict and the thermal-relief verdict.

**Charts** (drawn once per calc with `drawLineChart`, §2.6)
1. **Hydrate curve vs spread temperatures** (`#cj_chart_hyd`). x = temperature, y = pressure. Datasets: uninhibited T_hyd(P); inhibited curve shifted by the achieved depression; margin band; flowing spread path (nodes joined in flow order, as a polyline in data order); start-up path dashed; injection-point markers as single-point datasets.
2. **Pump rate vs setting** (`#cj_chart_pump`, for `cj_chart_line`). Plunger pumps: x = SPM 0…SPM_max, one line per plunger size (Q = K·d²·L·SPM·ηv), horizontal lines at design and peak rate, a vertical 2-point line at the amber limit (85 %), an operating-point marker. Metering pumps: x = % setting (S·N). Air-driven: x = air pressure, y = rate at P_req.

All chart labels, table headers, the summary chip and caution temperatures are built with `_pair()` (metric first in Metric mode, h2sroe L81 pattern). Totes show "1,041 L (275 gal)" in Metric.

**Notes:** six flat boxes (§8.1).

### 2.6 Phones (390 px) and iOS

- Cards stack in one column, and so do the fields: the host forces `.fg { grid-template-columns: 1fr; }` at ≤ 768 px (well-testing-app.html L520). No page-scoped override in the MVP.
- The jump bar (anchor links to the cards, results, charts and Notes, `rp-skip`) shortens the long column.
- The line-card summary chip stays visible under the card title.
- Wide tables (node table, pump options, summary) go inside an `overflow-x:auto` wrapper. No horizontal page scroll.
- Canvases are `<canvas width="720" height="300">` inside `.chart-wrap` with CSS `width:100%` (46-calc-gaspvt.js L445 pattern). They are drawn once per calc. No resize listener (one per render would pile up across page visits).
- iOS: nothing special. The global `ios-styles.css` 16 px form-control rule applies. Check with `gui-sweep.js --route cheminj --mobile` and `ios-webkit-check.js` where Playwright exists.

### 2.7 Sidebar placement (user decision Q1, before code)

Measured rows: Test System Safety 7 (hub:esd, hydrate, liquidline, pipelife, h2sroe, wellkill, complfluids); Fluids & Utilities 8 (at `MAX_ROWS = 8`).

**Option A (recommended for 3.2a): 8th row of Test System Safety.** Registry `group: 'Test System Safety'` and one host edit: add `'cheminj'` to `__NAV_ORDER` (L1406) next to `hydrate` and `h2sroe`. The group reaches the 8-row limit, which the sidebar test allows. Nothing in `__NAV_HUBS` changes.

**Option B: hub titled "Hydrate, H2S & Chemicals"** with members `['cheminj', 'hydrate', 'h2sroe']`. The title must not repeat the first tab's title, because H2S Exposure & Scavenger is mainly a radius-of-exposure safety calculator. Host edits: `__NAV_HUBS.hydrochem`, the hub row markup in Test System Safety (L754-761), `nav-hub-member` on the static `hydrate` button, `__NAV_ORDER`. HUBS in `tests/sidebar-nav.test.js` is updated in the same commit. Test System Safety then has 6 rows.

**In the same release, whichever option:**
- A one-line banner on the Hydrate page, class `rp-skip` (Round-5 rebuild of `25-hydrate.js`; Round 5 is in the harness build, tests/_harness.js L95): "Screening estimate: free water only, +30 % vapour allowance, 5 °F margin. Full design with condensed water, J-T and pump settings: Chemical Injection →". Reason: for the same ΔT (38.57 °F) `WTS_hydrate_injection_rate(38.57, 2, 'methanol')` gives 191.6 cc/min ≈ 72.9 gal/d, against 160.0 gal/d here (2.2×). Subject to Q2.
- A one-line cross-link on the host `chem` page (renderChem, L8831): "Injection point, pump stroke and hydrate/H2S dosing → Chemical Injection".
- The margin is stated in the node-table title and in every hydrate verdict, because the Hydrate page (25-hydrate.js L258) and Line Heat Loss (`MARGIN = 5`) use 5 °F, against 10 °F here.

---
## 3. Injection-point model

### 3.1 Points, conditions and how they are obtained

P_req is the pressure the pump must deliver while injecting. P_back is the maximum credible pressure the process can push back into the discharge circuit if the check valves leak; it sets the rating floor and the lowest PSV set (§4.11).

| key | Point (label) | Pressure used for dosing | P_req basis | P_back | Temperature | Phases present | Velocity / contact | Typical pump class |
|---|---|---|---|---|---|---|---|---|
| `dh` | Downhole — CIV / capillary / subsea-test-tree port | P_tub at depth (`cj_dh_ptub`); Phase 2: `WTS_flowline_march(…, {reverse:true})` from FWHP | max(flowing, shut-in) incl. CIV set, friction, hydrostatic (§4.11.2) | SITHP (gas migrating up a leaking capillary) | `cj_dh_tciv` (user; Phase 2 linear FWHT→BHT profile) | gas, free water, condensate/oil | tubing velocity from `WTS_gaspvt_z` Bg and `WTS_tubulars.capacity` | HP plunger (electric or pneumatic, small plunger), air-driven liquid pump, skid |
| `wh` | Flowhead / upstream of choke (upstream data header) | FWHP, FWHT (flowing); SITHP, T_amb (shut-in, start-up) | max(SITHP, FWHP) + allowance | SITHP | FWHT (flowing), T_amb (start-up) | gas, free water, liquid HC | v = q_g·Bg/A in segment 1; contact = Σ segments to separator | air-driven liquid pump, HP plunger, skid |
| `dsch` | Downstream of choke / heater inlet | P_ck | P_ck + allowance | `cj_psvsep` (a blocked separator lets this section rise to the PSV set) | T₂ design (isenthalpic × f_JT), or rule, or user | gas, free + condensed water, HC | segments 2–4 | pneumatic plunger, hydraulic-diaphragm metering |
| `sepin` | Heater outlet / separator inlet | P_sep | P_sep + allowance | `cj_psvsep` | T_htr if heater, else T₂ | gas, water, HC | segments 3–4 (or 4 only) | pneumatic plunger, metering diaphragm |
| `sepgas` | Separator gas outlet (upstream of back-pressure valve / meter) | P_sep | P_sep + allowance | `cj_psvsep` | T_sep; after the valve, T isenthalpic × f_JT to `cj_pbpv` | gas (saturated), carried mist | gas line | metering diaphragm, pneumatic plunger |
| `flare` | Flare / sales line downstream of the back-pressure valve | `cj_pbpv` | `cj_pbpv` + allowance | `cj_psvsep` (a failed-open back-pressure valve) | T after valve | gas | – | low pressure |
| `sepoil` | Separator oil outlet (upstream of level valve) | P_sep | P_sep + allowance | `cj_psvsep` | T_sep | oil/condensate | – | metering diaphragm whose P_max ≥ P_sep + allowance |
| `sepwat` | Separator water outlet | P_sep | P_sep + allowance | `cj_psvsep` | T_sep | water | – | metering diaphragm whose P_max ≥ P_sep + allowance |
| `tank` | Surge / gauge tank | 0 psig | 0 psig; fit an anti-siphon / back-pressure valve (≥ 25 psi over suction head) when the injection pressure is below the chemical-tank head | 0 | T_sep | oil or water | – | solenoid / mechanical diaphragm, air-operated diaphragm |

Engines and imports for P/T:
- **Isenthalpic choke:** new `WTS_gaspvt_isenthalpic` (DAK departure enthalpy, Sutton + Wichert–Aziz pseudo-criticals, ideal-gas Cp° already in `46-calc-gaspvt.js`). cheminj applies f_JT (§4.1).
- **Rule option:** `T₂ = T₁ − 0.07·ΔP` (same default μJT as lineheat, flowline and the simulator), with the label in §2.3.
- **Z, Bg, gas velocity and contact:** new `WTS_gaspvt_z({sg, p, t, co2, h2s, n2})` per node and per segment. It has no −40 °F floor (only a T_pr ≥ 1 guard) and costs one DAK solve, against about 3.4 ms per `WTS_gaspvt_compute` call (which also builds a 41-point Z curve and a real-gas Cp integral). All three gaspvt exports take impurities in **mol %**, like `compute()`. cheminj stores H2S in ppm and converts with ppm / 10⁴ in exactly one helper (`_ppmToMolPct`).
- **Imports (Phase 2):** `WTS_state.flow` (v 1) and `WTS_state.lineheat.result` (heater-inlet arrival temperature), §2.3.

### 3.2 Rules the engine applies

1. **First at-risk node.** A hydrate-inhibitor line must be upstream of the first node with T < T_hyd + margin. Otherwise: ✗ "Injection point is downstream of the first hydrate-risk node (<node>): move it upstream." Downstream-of-choke injection with a choke at risk gives ⚠ "the choke body and bean are not protected".
2. **Controlling node.** This is the node with the largest required X_R among nodes from the injection point to the separator inlet. The separator removes the rich water, so nodes after it are checked separately (rule 3).
3. **Second expansion (3.2b).** If the separator gas is re-expanded (`cj_pbpv`) and T_bpv < T_hyd(P_bpv) + margin, show ⚠ (✗ when T_bpv < T_hyd) with:
   - water condensed = q_g·max(0, W_sat(sep) − W_sat(bpv));
   - the dose needed at `sepgas`, split into aqueous and vapour loss;
   - a suggestion: add a line at `sepgas`, heat-trace, or lower the back-pressure (heating is preferred when vapour loss dominates).
   Methanol vapour carried from upstream is ignored (conservative, stated).
4. **Pressure.** Upstream-of-choke and downhole points use the shut-in case for P_req, and every point uses P_back for the rating and PSV floor (§4.11).
5. **Scavenger contact (3.2b).** Contact time is summed from the point to the separator over the pipe segments. Below `cj_tcreq` (15 s): ⚠. Aqueous scavenger at `sepgas`: ⚠ "needs a knock-out or contactor downstream, or liquid carries to the flare".
6. **Liquid-only chemicals** at gas-only points (or the reverse) get ✗.
7. **Downhole (3.2b).** Run the siphon check (§4.11.3). Aqueous scavengers downhole give ⚠ (hydrolysis at temperature, solids). KHI at T above the cloud point (user note; > ~150 °F screening [L]) gives ⚠.
8. **Aqueous chemicals and hydrates.** The water fraction of every active aqueous line upstream of the controlling node is added to the water to treat (§4.4). If such a line injects upstream of a hydrate-risk node and no THI line protects that node: ⚠ "{chemical} is about {w} % water and is injected upstream of a hydrate-risk node ({node}) with no hydrate inhibitor: it can form hydrate or ice there."
9. **Oxidisers (3.2b).** Hydrogen peroxide and sodium nitrite: tank is "N" with ⚠ "Oxidiser: O2 or NOx evolution into a hydrocarbon vapour space; dose only into a vented, non-hydrocarbon tank." Every oxidiser line also gets ⚠ "Never block in an oxidiser line: gas evolution overpressures it; fit vented relief." Nitrite adds ⚠ "Nitrite with acidic sour water can release NOx: keep pH above about 7 and ventilate."
10. **Drive gas.** With `cj_supgas` = `well` and H2S ≥ 10 ppm on any pneumatic or air-driven line: ✗ (§4.12.3); with sweet produced gas: ⚠ (methane venting at the pump).
11. **Hazardous area.** With `cj_haz` = yes, an electric pump gives ⚠ "Electric pump in a classified area: motor and controls must be certified for the zone (API RP 500/505)."

### 3.3 Chemical-family × point suitability matrix

Key: **R** = recommended (✓), **A** = allowed (✓ with any family note), **N** = not recommended (⚠ + reason), **X** = not applicable (✗).

| Family (chemicals) | dh | wh | dsch | sepin | sepgas | flare | sepoil | sepwat | tank |
|---|---|---|---|---|---|---|---|---|---|
| Thermodynamic hydrate inhibitor — methanol, ethanol | A (R when the wellbore crosses T_hyd) | **R** | A ⚠ choke unprotected | N (too late) | A (second-expansion point) | N | X | X | X |
| Thermodynamic hydrate inhibitor — MEG, DEG | A | **R** | A ⚠ | N | N (liquid carry-over) | X | X | X | X |
| LDHI — kinetic inhibitor (KHI) | A ⚠ cloud point | **R** | A | N | X | X | X | X | X |
| LDHI — anti-agglomerant (AA) | A | **R** | A | N | X | X | X | X | X |
| Aqueous H2S scavenger (MEA-/MMA-triazine, glyoxal, aldehyde-releaser blend) | N | **R** | A | A (short contact) | N (knock-out required) | X | N (MMA: A) | A (glyoxal) | N |
| Oil-phase scavenger (oil-soluble amine-aldehyde, zinc carboxylate) | X | A | N | N | X | X | **R** | X | A |
| Water-phase oxidiser scavenger (sodium nitrite, hydrogen peroxide) | X | X | X | X | X | X | X | **R** | N (O2/NOx into a hydrocarbon vapour space) |
| Corrosion inhibitor — oil-soluble film former | **R** | A | A | A | N | X | N | N | N |
| Corrosion inhibitor — water-soluble | **R** | A | A | A | X | X | X | A | N |
| Corrosion inhibitor — gas-well (pt/MMscf) | A | **R** | A | N | N | X | X | X | X |
| Scale inhibitor (phosphonate, polymeric) | **R** | A | A (heater inlet) | A | X | X | X | A | N |
| Antifoam (silicone, non-silicone) | X | N | A | **R** | X | X | N | X | A |
| Demulsifier | A | **R** | A | A | X | X | A | X | A |
| Water clarifier | X | N | N | A | X | X | X | **R** | A |
| Wax inhibitor | **R** (T > WAT) | A | A (only if T > WAT) | N | X | X | A | X | A |
| Pour-point depressant | N | A | A | N | X | X | **R** | X | A |
| Asphaltene inhibitor / dispersant | **R** (below onset depth) | A (dispersant) | N | N | X | X | N | X | N |
| Biocide, oxygen scavenger (water systems) | X | X | X | X | X | X | X | A | A |
| Custom | A | A | A | A | A | A | A | A | A |

### 3.4 Default η (scavenger utilisation) by point [L–M]

| Point | wh (atomised, upstream of choke) | dsch | sepin | sepgas | any point with contact ≥ 20 s |
|---|---|---|---|---|---|
| η default | 0.58 | 0.50 | 0.45 | 0.40 | user may raise to ≤ 0.70 (contact tower 0.75–0.85) |

η stays a plain, editable user input. The contact-time bands only drive a ⚠ (open question Q7). η is clamped so that R = R_th/η stays within the 0.1–10 gal/lb range of `WTS_h2s_scavenger` (for MEA-triazine η ≥ 0.087), with ⚠ when clamped.

---

## 4. Engineering methods

All internal arithmetic is in field units. Constants:
- water 8.337 lb/gal and 350.2 lb/bbl at 60 °F; liquid gradient 0.052 × 8.337 = 0.4335 psi/ft per unit SG (the same constant as `WTS_gradient_compute`);
- V_m (scf/lb-mol) from `WTS_baseConditions` (379.48 at 60 °F / 14.696 psia; follows the Std selector);
- 1 gal = 3.785411784 L = 231 in³; 1 in³ = 16.387064 mL;
- 1 gal/d = 2.62876 mL/min = 0.157725 L/h; 1 mL/s = 22.8245 gal/d.

### 4.1 Spread temperatures (J-T cooling across the choke) [M]

#### 4.1.1 Method

Solve h(T₂, P₂) = h(T₁, P₁) for T₂, where:
- h = h°(T) + (h − h°);
- h°(T) = ∫ Cp°(T) dT (Reid–Prausnitz–Poling polynomials, interpolated on molar mass, already in 46);
- (h − h°) = −R·T_pc·T_pr²·∫₀^{P_pr} (∂Z/∂T_pr)_{P_pr} dP_pr/P_pr, with DAK Z, Sutton pseudo-criticals and the Wichert–Aziz correction. The integral uses 40-point Gauss–Legendre quadrature on [0, P_pr] (the integrand is finite at P_pr → 0); ∂Z/∂T_pr is a central difference (δ = 10⁻⁴).

**Design temperature:** T₂,design = T₁ − f_JT·(T₁ − T₂,DAK), f_JT = `cj_fjt` (default 1.10). The same factor applies to every isenthalpic node (choke flowing, start-up, back-pressure valve). The node table shows the design temperature and the Design basis box states the factor.

#### 4.1.2 Solver and cost

- Predictor T₂⁰ = T₁ − μJT(T₁, P₁)·(P₁ − P₂), clipped to the bracket [T_lo, T₁ + 20 °F], T_lo = max(−80 °F, 1.02·T_pc − 459.67).
- Newton on f(T₂) = h(T₂, P₂) − h₁ with slope **Cp(T₂, P₂) = ∂h/∂T|_P** (the real-gas Cp, from the same departure function as 46's existing Cp). Bisection fallback when a step leaves the bracket. Converge to |ΔT| < 0.01 °F; at most 30 iterations.
- Prototype (`rev_jt.js`): 2–5 Newton steps and about 800 DAK evaluations per solve; about 1 ms per solve once warm (12.6 ms for the very first call). The earlier 60-step bisection prototype took about 117 ms per solve.
- Memo: a bounded Map of 64 entries keyed by the inputs rounded to 0.001 (sg, p1, t1, p2, yCO2, yH2S, yN2), least-recently-used eviction, **not** cleared per calc. A repeat solve costs about 0.02 ms.
- `WTS_gaspvt_isenthalpic.stats()` → `{solves, hits}` so tests assert solve counts, not wall-clock time.
- Warnings: T₂ < −40 °F (below the gaspvt `compute()` validation range), P_pr > 15, or near J-T inversion (μJT < 0.002 °F/psi at P > 5000 psia).

#### 4.1.3 Validation and the design factor

**Pure methane, μJT (K/MPa): DAK (Sutton pseudo-criticals at γ 0.5539) with the real-gas Cp, against the NIST Chemistry WebBook (reference equation of state for methane, Setzmann–Wagner 1991), retrieved 2026-10-31.**

| T | P (MPa) | DAK | NIST | NIST / DAK |
|---|---|---|---|---|
| 300 K (80 °F) | 0.1 | 3.969 | 4.322 | 1.089 |
| 300 K | 2.1 | 3.885 | 4.197 | 1.080 |
| 300 K | 5.1 | 3.680 | 3.932 | 1.069 |
| 300 K | 10.1 | 3.077 | 3.244 | 1.054 |
| 250 K (−10 °F) | 0.1 | 6.197 | 6.192 | 0.999 |
| 250 K | 2.1 | 6.033 | 6.124 | 1.015 |
| 250 K | 5.1 | 5.617 | 5.783 | 1.030 |
| 250 K | 10.1 | 4.001 | 4.130 | 1.032 |

DAK under-predicts methane J-T cooling by 0–9 %, most at warm, low-pressure conditions. With the true methane critical constants NIST/DAK is 0.95–1.04, so most of the bias comes from the gravity-based pseudo-criticals. Peng–Robinson (reviewer's pure-methane check) over-predicts methane μJT by about 17 % at 300 K / 0.1 MPa (5.04 vs 4.32 K/MPa), so PR is a cold bound rather than the truth. The PR mixture values below are the reviewer's, for a 0.642-SG composition (slightly lighter than γ 0.65).

**Mixture check: Katz (1945) permissible-expansion chart for 0.6-gravity gas, as reproduced in the GPSA Engineering Data Book** (lowest final pressure without hydrate, from 2000 psia; T_hyd from Towler–Mokhatab, which is a fit to the Katz gravity chart):

| T₁ | DAK alone | DAK × 1.10 | Chart reading |
|---|---|---|---|
| 100 °F | 1040 psia | 1130 psia | ≈ 1100 psia [M, from memory: to be read off the chart before release] |
| 120 °F | no limit (to atmospheric) | 510 psia | ≈ 400 psia [L–M, secondary source] |
| 140 °F | no limit | no limit | to atmospheric [M] |

**Choice:** f_JT = 1.10 is at or above the largest methane bias (1.089) and makes the 120 °F chart case finite and conservative, where DAK alone fails it. For H1 it lands close to the PR answer (34.6 vs 35.8 °F). Validation for γ > 0.7 has no reference yet [M]. Tests V1–V2 (§7.1) guard the factor. Q17 asks whether to relax it once the GPSA chart values are confirmed.

#### 4.1.4 Reference tables (γ 0.65)

μJT (°F/psi), DAK with real-gas Cp; Peng–Robinson (reviewer, 0.642-SG composition) in brackets:

| P (psia) | 0 °F | 40 °F | 80 °F | 120 °F | 160 °F |
|---|---|---|---|---|---|
| 500 | 0.082 (0.099) | 0.067 (0.082) | 0.055 (0.068) | 0.046 (0.058) | 0.039 (0.050) |
| 1000 | 0.072 | 0.060 (0.070) | 0.051 (0.059) | 0.043 (0.051) | 0.036 (0.044) |
| 2000 | 0.027 | 0.033 (0.033) | 0.033 (0.034) | 0.030 (0.032) | 0.027 (0.030) |
| 3000 | 0.009 | 0.014 (0.015) | 0.017 (0.017) | 0.018 (0.018) | 0.017 (0.018) |

At 0 °F and 500 psia a 0.8-gravity gas gives 0.106 °F/psi (DAK). Cold, low-pressure μJT exceeds the 0.07 °F/psi of the rule.

Choke drops (°F):

| T₁ | P₁ → P₂ (psia) | DAK | **Design (× 1.10)** | Peng–Robinson | Rule 7 °F/100 psi |
|---|---|---|---|---|---|
| 110 | 3014.7 → 1014.7 (H1) | 41.42 | **34.56** | 35.84 | −30.0 |
| 100 | 2000 → 500 | 25.26 | **17.78** | 13.32 | −5.0 |
| 80 | 1000 → 100 | 24.24 | **18.67** | 10.76 | 17.0 |
| 60 | 3514.7 → 1014.7 (start-up) | −18.81 | **−26.69** | −21.37 | −115.0 |
| 90 | 1014.7 → 264.7 (second expansion) | 47.51 | **43.27** | 37.53 | 37.5 |
| 100 | 999.7 → 314.7 (S1) | 63.55 | **59.90** | – | 52.0 |

#### 4.1.5 Rule option and others

- **Rule:** T₂ = T₁ − 0.07·(P₁ − P₂). Label: "quick check; overstates cooling for drops starting above ~2000 psi, may understate it below ~1000 psi and 40 °F".
- **Liquids (Phase 2) [M]:** ΔT_mix = ΔT_gas·ṁ_g·c_p,g/(ṁ_g·c_p,g + ṁ_o·c_p,o + ṁ_w·c_p,w). Under 0.2 % for H1; matters for oil wells.
- **Heater alternative (Phase 2):** the upstream temperature T₁* that gives T₂,design = T_hyd + margin. Solved as an inverse root-find: for a trial T₁*, the DAK target is T₂* = T₁* − (T₁* − T_target)/f_JT, and h(T₁*, P₁) = h(T₂*, P₂) is solved for T₁* by Newton with slope Cp(T₁*, P₁); 3–4 outer steps. H1: **142.1 °F** (DAK alone 136.9 °F).

### 4.2 Hydrate formation temperature

- **Correlation [M]:** T_hyd(°F) = 13.47 ln P + 34.27 ln γ − 1.675 ln P·ln γ − 20.35 (P psia, γ 0.55–1.0). This is Towler–Mokhatab (2005), via the existing `WTS_hydrate_temp(P_psia, sg)`. No second curve is allowed. `WTS_hydrate_temp` clamps γ to 0.55–1.0 without telling the caller, so cheminj raises its own ⚠ for γ > 1.0 or < 0.55.
- **User override:** the curve is shifted in parallel, T_hyd,u(P) = T_TM(P) + (T_user − T_TM(P_user)).
- **Sour gas with the correlation [M]:**
  - H2S ≤ 0.1 mol % (1,000 ppm): no adder.
  - 0.1 < H2S ≤ 3 mol %: design margin = `cj_margin` + max(`cj_sour`, `cj_sour`·y_H2S(mol %)). With the default 5 °F that is 5 °F up to 1 mol %, 10 °F at 2 mol %, 15 °F at 3 mol %. ⚠ "Sweet-gas hydrate correlation used on sour gas: margin raised by {a} °F (margin now {m} °F). Enter a lab or composition-based hydrate temperature."
  - H2S > 3 mol %: ✗ "H2S {y} mol % is beyond the sweet-gas correlation: enter a lab or composition-based hydrate temperature. No rate given." A user T_hyd lifts the ✗.
  - CO2 > 5 mol %: flat `cj_sour` adder with ⚠; CO2 > 20 mol %: ✗ as above.
  - Basis: the Baillie–Wichert (1987) chart shows H2S raising T_hyd by roughly 10–20 °F at 5–10 mol % near 1000 psia [M, from memory]; the rule stays conservative up to its 3 mol % cut-off.
- Values (γ 0.65): 30.2 °F at 100 psia; 44.1 at 264.7; 46.5 at 314.7; 53.1 at 500; 63.13 at 1014.7; 78.6 at 3014.7; 80.8 at 3514.7.

### 4.3 Thermodynamic inhibitor depression and required concentration

Notation: W = wt % inhibitor in the aqueous phase; ΔT in °F.

- **Hammerschmidt (1934) [H]:**
  - ΔT = K·W/(M·(100 − W)); inverse W = 100·ΔT·M/(K + ΔT·M);
  - for MeOH/MEG/DEG/TEG call `WTS_hammerschmidt_depression` / `_invert` (25-hydrate.js: M = 32/62/106/150, K = 2335/2700/4000/5400) through an explicit map `{meoh:'methanol', meg:'meg', deg:'deg', teg:'teg'}`. Those engines know only 'methanol', 'meg', 'deg' and 'teg', and `_inhib()` (L104-108) silently falls back to methanol for any other key (`WTS_hammerschmidt_invert(31.73, 'meoh')` and `(31.73, 'etoh')` both return the methanol value 30.31 wt %);
  - ethanol is never passed to them: it is computed locally with M = 46.07, K = 2335;
  - `WTS_hammerschmidt_invert` clamps silently at 80 wt % (L169). A result ≥ 79.99 wt % is treated as out of range (✗, no rate). DEG reaches the clamp at ΔT ≈ 150 °F (verified: 79.90 wt %).
- **Nielsen–Bucklin (1983) [H]:**
  - ΔT = −129.6·ln x_w (x_w = water mole fraction);
  - inverse x_I = 1 − exp(−ΔT/129.6), W = 100·x_I·M/(18.015 + x_I·(M − 18.015)) with exact M (32.04, 46.07, 62.07);
  - implemented once, in cheminj.
- **Design rule (`auto`):**
  - methanol, ethanol, MEG: **W = max(W_Ham, W_NB)**, with the Hammerschmidt value always shown for reference. For methanol, Nielsen–Bucklin is the larger at every concentration (20 wt %: Hammerschmidt predicts 18.24 °F depression, NB 17.05 °F; 25 wt %: 24.32 vs 22.26 °F), so the old switch at 25 wt % and its 1.9 wt % step are gone;
  - DEG/TEG: Hammerschmidt only, with ⚠ "limited validation, rarely injected (TEG is a dehydration glycol)";
  - `ham` / `nb` forced: comparison only, with ⚠ "forced method, not the design value".
- **Practical limits:**
  - ⚠ above 50 wt % (MeOH, EtOH) or 60 wt % (MEG, DEG): "chemical-only inhibition is marginal — heat, stage the choke or start on a small choke";
  - ✗ above 70 wt % (all inhibitors; beyond the vapour-loss correlation for methanol) or when the Hammerschmidt invert reaches its 80 wt % clamp: no rate is given.
- **Rich-phase freeze check [M]:** interpolate MeOH–water (5 °F at 20 wt %, −15 at 30, −38 at 40, −65 at 50) and MEG–water (18 °F at 20 wt %, 5 at 30, −11 at 40, −33 at 50, −54 at 60). ⚠ if the freeze point > T_min − 5 °F.

Check values:
- Hammerschmidt MeOH 25 wt % → **24.32 °F** (25-hydrate M = 32).
- NB at x_I = 0.13 → 18.05 °F, which needs MeOH 21.00 wt %, MEG 33.99 wt %.
- NB MeOH at 28.85 wt % → 26.62 °F; at 46.53 wt % → 51.62 °F.

### 4.4 Water to treat

- **Free (formation) water [H]:** m_prod (lb/d) = q_w·350.2·SG_w.
- **Water content of the gas (Bukacek 1955) [M-H]:**
  - W (lb/MMscf) = 47,484·p_v/P + B, with log₁₀B = −3083.87/(T + 459.6) + 6.69449 (T °F, P and p_v psia);
  - stated range 60–460 °F, 15–10,000 psia; flag extrapolation below 60 °F;
  - p_v is Wagner & Pruss (1993): ln(p_v/p_c) = (T_c/T)(a₁τ + a₂τ^1.5 + a₃τ³ + a₄τ^3.5 + a₅τ⁴ + a₆τ^7.5), τ = 1 − T/T_c, T_c = 647.096 K, p_c = 22.064 MPa, a = (−7.85951783, 1.84408259, −11.7866497, 22.6807411, −15.9618719, 1.80122502);
  - checks: p_v = 0.2564 psia at 60 °F, 0.9505 at 100 °F, 14.71 at 212 °F; W = 60.40 at 1000 psia/100 °F, 17.92 at 1000/60, 39.18 at 3014.7/110, 7.44 at 1014.7/34.56 lb/MMscf.
- **Condensed water:** m_cond = q_g·(W(P_sat, T_sat) − W(P_ctrl, T_ctrl)). "sat" is the flowing wellhead (gas assumed saturated there); "ctrl" is the controlling node at its design temperature. Option `all`: W_ctrl = 0.
- **Water basis `sep`** (rate measured at the separator): m_W = q_w·350.2·SG_w + q_g·(W_sep − W_ctrl). This avoids double-counting the water that condensed between the wellhead and the separator.
- **Water carried in by other chemicals:** m_W += Σ_j w_j·ṁ_sol,j over every active line j (other than the THI line being designed) whose point is at or upstream of the controlling node, where w_j is the product's water mass fraction (`water` in `WTS_chemlib`, editable as `cj_wat_n`) and ṁ_sol,j = V_j (gal/d)·8.337·SG_j. Typical w: aqueous triazine 0.50–0.60, water-based corrosion and scale inhibitors 0.5–0.8, KHI carriers 0–0.5 [M]. Example: an S1-size MEA-triazine line (30.95 gal/d, SG 1.11, w 0.60) adds **171.8 lb/d**. Lean-glycol water is handled by the X_L balance (§4.5), not here.
- **Sour gas:** H2S/CO2 raise the water content at high P. ⚠ for sour gas; no correction in the MVP.

### 4.5 Inhibitor mass balance and volume

- **Rigorous lean-solution balance [H]:** a lean solution L (lb/d) at X_L feeds a rich aqueous phase at X_R (mass fractions), plus vapour and condensate losses. Water balance and inhibitor balance give
  - **L = [X_R·m_W + (m_vap + m_LHC)·(1 − X_R)] / (X_L − X_R)**.
  - At X_L = 1 it reduces to m_W·X_R/(1 − X_R) + m_vap + m_LHC (pure inhibitor). The earlier form m_W·X_R/(X_L − X_R) + (m_vap + m_LHC)/X_L ignored the water carried by the extra lean solution that covers the losses (−1.3 % at H1 with 95 % lean).
  - Glycols: L = [X_R·m_W/(X_L − X_R)]·(1 + `cj_glyloss`/100).
- **Methanol vapour loss, "K-value express" (Moshfeghian 2011) [M-H]:**
  - P* = P/35 (psia); T* = T(°R)/615;
  - ω* = 2.95 − 0.02607·P* + 8.92828×10⁻⁵·P*² − 0.851257/T*;
  - K = (1/P*)·exp[5.37·(1 + ω*)·(1 − 1/T*)];
  - m_vap (lb/d) = q_g·(10⁶·32.04/V_m)·K·x_MeOH = q_g·**84,431**·K·x_MeOH at V_m 379.48, evaluated at the controlling node;
  - range −10 to 100 °F, 100–5000 psia, ≤ 70 wt % (warn outside);
  - check: K(1000 psia, 10 °F) = 9.614×10⁻⁴ → **12.81** lb/MMscf at 25 wt % (published 12.4; the correlation's reported average error is 3.6 %);
  - ethanol uses the methanol correlation (conservative, since ethanol is less volatile) with ⚠ [L].
- **Condensate loss [L–M]:** m_LHC = q_o·f_c, with f_c = `cj_fc`·x_MeOH/x_ref, where `cj_fc` (default 0.25 lb/bbl) is the loss at the reference aqueous concentration of 30 wt % (x_ref = 0.1942) and about 40 °F. Methanol solubility in liquid hydrocarbon rises roughly in proportion to the aqueous methanol mole fraction (GPSA Engineering Data Book, methanol solubility in liquid hydrocarbon figure). Label: "paraffinic condensate; aromatic condensate holds more — raise f_c". Ethanol uses the same rule.
- **Volume:** solution volume with ideal volume mixing, 1/ρ_sol = X_L/ρ_I + (1 − X_L)/ρ_w (slightly overstates gallons, i.e. conservative).

### 4.6 Low-dosage hydrate inhibitors (KHI, AA) [M; formulation-specific] — 3.2b

- **Dose:** V (gal/d) = dose (vol %)/100 × q_w,ctrl (bbl/d) × 42, where q_w,ctrl = q_w + m_cond/350.2 (free water plus condensed fresh water). The dose is product (as supplied).
- **Defaults:** KHI 1.5 vol % (range 0.5–3); AA 2.0 vol % (range 0.5–3) of the water phase.
- **Screening logic** on the **largest subcooling over the flowing controlling node, the shut-in flowhead (SITHP, T_amb) and the start-up choke outlet**, ΔT_sub = T_hyd − T:
  - ≤ 0 everywhere: "no inhibitor needed";
  - KHI ✓ if max ΔT_sub ≤ 15 °F and the hold time ≥ residence time + planned shut-in;
  - 15–27 °F: ⚠ "advanced KHI only, with qualification";
  - > 27 °F: ✗ KHI, naming the case that fails;
  - AA ✓ only if a liquid hydrocarbon is present and water cut ≤ 50 %, else ✗.
- **Mandatory note:** "screening ranges; qualify by rocking-cell or autoclave test; a THI is the default for short tests that may be shut in unexpectedly".
- **Example:** H1 water 2 + 317.4/350.2 = 2.906 bbl/d → KHI 1.5 % = **1.83 gal/d** (vs 160.0 gal/d methanol). Subcooling: flowing 28.6 °F, shut-in 20.8 °F (T_amb 60 °F), start-up 89.8 °F → **KHI ✗** (start-up). With T_amb 50 °F the shut-in case alone gives 30.8 °F → ✗. 100 bbl/d water at 1.5 % → **63.0 gal/d**.

### 4.7 Start-up and shut-in

- **Start-up (cold tree) node:** P = SITHP, T = T_amb, then the isenthalpic drop to P_ck at design (× f_JT). The required X_R is shown with its practical-limit verdict. The pump peak factor covers the start-up rate.
- **Shut-in:** trapped free water at SITHP and T_amb needs X_R for ΔT = T_hyd(SITHP) − T_amb + margin, by the design rule (§4.3). Examples (SITHP 3500 psig, margin 10 °F):
  - T_amb 60 °F (H1 default): ΔT 30.76 °F → MeOH **32.27 wt %** (NB; Hammerschmidt 29.65); MEG **47.99 wt %** (NB; Hammerschmidt 41.39).
  - T_amb 50 °F: ΔT 40.76 °F → MeOH **39.66 wt %**; MEG **56.01 wt %** (NB; Hammerschmidt 48.34), close to the 60 wt % ⚠ band.
- **Batch volume (3.2b, Card 12):** V = Σ 0.0408·ID²·L over the Card 2 segments up to the chosen fill point (gal; ID in, L ft) + tree volume. A downhole pill uses `WTS_tubulars.capacity(ID)` (bbl/ft) × MD.
- **Advice text** (industry practice [M]): heater lit and at temperature before flow; pre-fill the flowhead/manifold; start the pump before opening; open on a small choke at 2–3× the steady rate for the first 30–60 min; step the choke up as FWHT rises.

### 4.8 H2S quantities, targets and scavengers (3.2b)

- **Mass flow [H]:** ṁ_H2S (lb/d) = q_g·y·34.081/V_m = **0.08981·q_g·y** at V_m 379.48 (q_g MMscf/d, y ppm mol). Metric: 1 ppm = 1.441 mg/Sm³ at the 15 °C / 101.325 kPa base (1.521 mg/m³ at 0 °C).
- **Liquid term:** ṁ_liq = q_o·350.2·SG_o·C_o·10⁻⁶ + q_w·350.2·SG_w·C_w·10⁻⁶ (C in ppmw).
- **Removed:** ṁ_rem = 0.08981·q_g·(y_in − y_out) + ṁ_liq (liquid term only when the point is upstream of the separator).
- **Targets:**
  - fixed ppm: 4 ppm (0.25 gr/100 scf), 10 ppm, 1 ppm;
  - 5 mg/m³: converted with the active base conditions, y = 5·V_m,SI/(34.081·1000) ppm = **3.47 ppm** at 15 °C (3.29 ppm at 0 °C); the label shows the base;
  - flare SO2 limit: y_out = SO2_allow (lb/h)·24·V_m/(64.064·CE·q_g); e.g. 10 lb/h, 5 MMscf/d, CE 0.98 → 290 ppm;
  - custom.
- **Partial pressure (information):** p_H2S = y·10⁻⁶·P_abs; ⚠ "Sour service (≥ 0.05 psia, ISO 15156 / NACE MR0175): equipment must be rated for the untreated fluid; scavenging does not change the materials basis".
- **Scavenger ratio [H for triazine stoichiometry]:**
  - R_th (gal/lb H2S) = (MW_a/(n·34.081))/(w_a·8.337·SG_p);
  - R = R_th/η;
  - V (gal/d) = ṁ_rem·R. The gas part calls **`WTS_h2s_scavenger(q_g, y_in, y_out, R)`** (same base conditions and validation; it requires 0 < q_g ≤ 500, 0 < y_in ≤ 100,000 ppm, 0 ≤ y_out < y_in and 0.1 ≤ R ≤ 10, and returns `ok:false` otherwise);
  - MEA-triazine: MW 219.28, n = 2 → 3.217 lb active/lb H2S; 40 % active, SG 1.11 → R_th = 0.869 gal/lb; field use 12–20 lb product/lb = 1.3–2.2 gal/lb (η ≈ 0.40–0.67).
- **Guards before calling the engine** (each maps to a planned verdict with rate 0, never an engine error):
  - y_in = 0 → ✓ "No H2S: no scavenger needed";
  - y_out ≥ y_in → ✓ "Inlet is already at or below the target";
  - q_g = 0 → ✗ "needs gas rate" for gas-basis lines;
  - η so low that R > 10 (MEA-triazine η < 0.087) → η clamped with ⚠; any other `ok:false` shows the engine's own message.
- **SO2 avoided** = so2(y_in) − so2(y_out), both from `WTS_h2s_so2(q_g, y, CE)` (lb/h × 24 → lb/d), so combustion efficiency is included. S1: 1.7234 − 0.1379 lb/h = **38.05 lb/d** at CE 98 %.
- **Contact time:**
  - t_c = Σ L_i·A_i/Q_a,i, with Q_a (ft³/s) = q_g·10⁶·B_g/86,400 and B_g = 0.02827·Z·T(°R)/P(psia), Z from `WTS_gaspvt_z`;
  - ⚠ if t_c < `cj_tcreq`; ⚠ if any segment velocity exceeds 80 % of the API RP 14E erosional velocity v_e = C/√ρ (C = 100);
  - note "15–20 s is supplier-cited guidance from academic work [L]; check with length-of-stain tubes (ASTM D4810) at the separator gas outlet and trim the pump".
- **Mercaptans:** information line only (lb/d = q_g·y·MW/V_m; methyl mercaptan 0.1268 lb/d per MMscf/d·ppm). "Triazine removes light mercaptans only partly; not counted."
- **Sampling note:** "Take PVT and H2S samples upstream of the scavenger, or with it off; record the untreated H2S for the radius of exposure."

### 4.9 ppm-basis chemicals (corrosion, scale, antifoam, demulsifier, clarifier, wax, asphaltene, biocide)

Every ppm dose is **product (as supplied)**; the basis label says so. An optional active % (advanced) shows the active dose alongside (active ppm = product ppm × active %). Minimum inhibitor concentrations are usually quoted as ppm active, and products are typically 20–40 % active [M].

| Basis key | Meaning | Equation (gal/d) |
|---|---|---|
| `ppmv_oil` | ppm by volume on oil/condensate | 42·q_o·C·10⁻⁶ |
| `ppmv_water` | ppm v on water | 42·q_w·C·10⁻⁶ |
| `ppmv_liq` | ppm v on total liquid | 42·(q_o + q_w)·C·10⁻⁶ (identical to the host `chem` page: cc/min = BPD·ppm·1.10408×10⁻⁴) |
| `ppmw_water` | ppm by mass on water | 42·q_w·C·10⁻⁶·SG_w/SG_c |
| `ppmw_oil` | ppm w on oil | 42·q_o·C·10⁻⁶·SG_o/SG_c, with SG_o = 141.5/(131.5 + API) |
| `pt_mmscf` | US pt per MMscf | q_g·C/8 |
| `gal_mmscf` | gal per MMscf | q_g·C |
| `l_1e6sm3` | L per 10⁶ Sm³ | q_g·0.0283168·C/3.7854 |
| `vol_water` | vol % of water (LDHI) | q_w,ctrl·42·C/100 |
| `wt_water` | wt % in water (THI) | §4.5 |
| `gal_lb_h2s` / `l_kg_h2s` | product per lb (kg) H2S removed | §4.8 |
| `ppm_per_ppm_liq` | product ppm (mass) per ppm H2S in liquid (oil-phase scavengers) | 42·q_o·(R·C_H2S,o)·10⁻⁶·SG_o/SG_c |
| `ppm_per_ppm_o2` | product ppm (mass) per ppm O2 (water systems) | 42·q_w·(R·C_O2)·10⁻⁶·SG_w/SG_c |
| `batch_gal` | batch volume | user volume |

The rate is computed on the phase present at the point; for example, `ppmv_oil` at `sepwat` is ✗. **Turndown (one rule everywhere):** ⚠ if f = Q/Q_max < max(0.10, S_min·N_min): "below pump turndown — dilute 1 : n in a compatible carrier or use a smaller head", n = ceil(0.25·Q_max/Q).

Worked numbers:

| Chemical | Dose | Stream | gal/d | mL/min |
|---|---|---|---|---|
| Corrosion inhibitor, film-forming | 25 ppm v | 5000 bbl/d total liquid | 5.25 | 13.80 |
| Demulsifier | 30 ppm v | 3000 bopd | 3.78 | 9.94 |
| Scale inhibitor, phosphonate | 10 ppm w (SG_w 1.05, SG_c 1.20 → 8.75 ppm v) | 2000 bwpd | 0.735 | 1.93 |
| Silicone antifoam | 5 ppm v | 3000 bopd | 0.630 | 1.66 (⚠ dilute on a 10 L/h pump) |
| Wax inhibitor | 200 ppm v | 2000 bopd | 16.8 | 44.2 |
| Asphaltene inhibitor | 200 ppm v | 3000 bopd | 25.2 | 66.2 |
| Gas-well corrosion inhibitor | 1 pt/MMscf | 20 MMscf/d | 2.50 | 6.57 |
| Ammonium bisulfite 65 % | 10 ppm per ppm O2, 0.5 ppm O2 (SG_w 1.05, SG_c 1.35) | 1000 bwpd | 0.163 | 0.429 |
| Identity with `chem` page | 10 ppm v | 12,000 BPD | **5.04** | **13.2489** |

### 4.10 Pump displacement and settings

#### 4.10.1 Plunger pumps [H, geometry]

- V_s = (π/4)·d²·L (in³) × 16.387064 → mL (swept). Metric: V_s (mL) = 7.854×10⁻⁴·d_mm²·L_mm. Delivered per stroke = V_s·ηv; a drawdown check sees the delivered volume.
- Q = n_h·V_s·SPM·ηv, so **SPM = Q/(n_h·V_s·ηv)**.
- Field constants (d, L in inches):
  - Q (gal/d) = **4.896**·d²·L·SPM·ηv;
  - Q (L/h) = **0.7722**·d²·L·SPM·ηv;
  - Q (mL/min) = **12.870**·d²·L·SPM·ηv.
- Field outputs: seconds/stroke = 60/SPM; strokes per 15 s = SPM/4.

| d (in) | 3/16 | 1/4 | 5/16 | 3/8 | 1/2 | 5/8 | 3/4 | 7/8 | 1 | 1-1/4 |
|---|---|---|---|---|---|---|---|---|---|---|
| mL/stroke swept (L = 1 in) | 0.452 | 0.804 | 1.257 | 1.810 | 3.218 | 5.027 | 7.240 | 9.854 | 12.87 | 20.11 |
| gal/d per SPM (ηv = 1) | 0.172 | 0.306 | 0.478 | 0.689 | 1.224 | 1.912 | 2.754 | 3.748 | 4.896 | 7.650 |

#### 4.10.2 Volumetric efficiency (auto model, used when `cj_ve_n` is blank) [M]

ηv = 1 − β·(P_d − P_s)·(1 + V_c/V_s) − s_valve.
- Defaults: V_c/V_s = 0.5 at full stroke, scaled by (L_max/L) at a shorter stroke; s_valve = 0.03.
- β (psi⁻¹): methanol 8.6×10⁻⁶, water-based 3.1×10⁻⁶, MEG 2.5×10⁻⁶, hydrocarbon-solvent products 7×10⁻⁶ [L].
- Example: methanol at 4000 psi loses 5.2 % to compressibility.
- ⚠ when ηv < 0.80: "check valves, packing or gas lock". Flooded suction and a shaded tank are required for methanol (p_v ≈ 4.6 psia at 77 °F; vapour lock and NPSH).

#### 4.10.3 Pump pressure capability

- **Pneumatic plunger** (n_h plungers on one actuator): P_max = min(body rating, η_m·P_s·A_act/(n_h·A_pl)), η_m = 0.8, A = (π/4)D². Actuators 4, 6 and 8 in. At 100 psig, simplex:

| Plunger | 4 in actuator | 6 in | 8 in |
|---|---|---|---|
| 3/8 in | 9,102 psi | 10,000 (body) | 10,000 (body) |
| 1/2 in | 5,120 | 10,000 (body) | 10,000 (body) |
| 3/4 in | 2,276 | 5,120 | 9,102 |
| 1 in | 1,280 | 2,880 | 5,120 |

  A duplex (two plungers on one actuator) halves these.
- **Electric plunger:** P_max = min(15,000, F_rod/A_pl). With 2,500 lbf: 5/8 in → 8,149 psi; 3/4 → 5,659; 7/8 → 4,158; 1 in → 3,183. Each head has its own throw.
- **Metering diaphragm:** P_max from preset or nameplate.
- **Air-driven liquid pump (pressure amplifier) [M]:** stall pressure P_stall = r·P_air (r = area ratio). Illustrative linear curve Q(P_d, P_air) = Q₀·(1 − P_d/(r·P_air)), with Q₀ the free-flow rate at full air. Replace with the pump's published curve.
  - Air setting for a target flow: **P_air = P_d/(r·(1 − Q/Q₀))**, computed for the design and the peak rate.
  - Cycles/min (field count) = Q (gal/d)·231/1440/V_cyc (in³ per cycle).
  - Feasible if Q_peak ≤ Q(P_req, P_air,avail), P_req ≤ 0.7·r·P_air,avail, design Q ≥ 0.1·Q₀ (low-flow cycling becomes erratic) and the peak air setting ≤ `cj_psup`.
  - Not a metering pump: "set and verify by drawdown cylinder or in-line meter (mandatory); the air setting is a starting point". The stall pressure at the design setting is shown; the discharge PSV, not the air regulator, is the overpressure protection.

#### 4.10.4 Metering (diaphragm / electric plunger with stroke knob) settings [M]

- Q = Q_max·(S/100)·(N/100), with Q_max = rated (diaphragm) or n_h·V_s(L_max)·SPM_crank·ηv (electric plunger).
- f = Q_req/Q_max. Algorithm:
  - if f ≥ 0.5: S = 100, N = 100·f;
  - otherwise S = max(S_min, ceil₅(200·f)), N = 100·f/(S/100);
  - a fixed-speed electric plunger (no VFD) uses N = 100, S = 100·f;
  - S_min = 20 % for solenoid/mechanical diaphragm, 10 % for API 675 plunger/hydraulic diaphragm; N_min = 10 %.
- ✗ if f > 0.9 (no headroom); ⚠ turndown if f < max(0.10, S_min·N_min) (§4.9).

#### 4.10.5 Bands and feasibility (all thresholds editable)

- **Band of design SPM/SPM_max (or f, or air setting/P_air,avail):** green 20–70 %; amber 10–20 % or 70–85 %; red < 10 % or > 85 %.
- **Feasible if all of:**
  - peak (design × peak factor) ≤ 85 %;
  - minimum (design × `cj_minf`) ≥ SPM_min,stable (3 SPM pneumatic) or max(0.10, S_min·N_min) (metering);
  - P_max ≥ required rating (§4.11);
  - for pneumatic and air-driven pumps, the drive-gas pressure needed at the design (shut-in) pressure ≤ `cj_psup` (§4.12.3).

#### 4.10.6 Ranking and suggestions

Candidates: every plunger × stroke × heads (1–3 electric; 1–2 pneumatic) × actuator (4, 6, 8 in pneumatic), the metering presets and the air-driven preset. Rank:
1. feasible first;
2. hazardous-area suitability: with `cj_haz` = yes, pneumatic and air-driven pumps rank before electric ones;
3. fewer heads (simpler);
4. design closest to the 40–50 % band;
5. larger plunger, longer stroke.

If nothing is feasible, say why:
- "rate-limited → two pumps in parallel, air-driven liquid pump, electric plunger or skid";
- "pressure-limited → smaller plunger, larger actuator, air-driven pump or electric plunger".

**Next plunger:** if design > 85 %, the next larger plunger whose P_max still passes; if < 10 %, the next smaller.

### 4.11 Discharge pressure

#### 4.11.1 Surface points [M, practice]

- **Required pressure:** P_req = P_line,design + ΔP_q (quill/nozzle + check valves, default 50 psi) + ΔP_line. P_line,design: max(SITHP, FWHP) at `wh`; P_ck at `dsch`; P_sep at `sepin`/`sepgas`/`sepoil`/`sepwat`; P_bpv at `flare`; 0 at `tank`.
- **Back-pressure P_back** (§3.1): SITHP for `wh` and `dh`; `cj_psvsep` (separator PSV set = MAWP of the choke-to-separator section) for `dsch`, `sepin`, `sepgas`, `sepoil`, `sepwat` and `flare`; 0 at `tank`. With `cj_ratebasis` = `class`, P_back is the full tie-in class (`cj_whclass` for `wh`/`dh`, `cj_psvsep` elsewhere).
- **Rating:** P_rating ≥ max(P_req·(1 + m%/100), P_req + m_abs, P_back·(1 + m%/100), P_back + m_abs); default margins 10 % and 100 psi.
- **PSV set band:** lo = max(1.10·P_req, P_back) (never below the shut-in wellhead pressure for wellbore-connected lines, so a leaking check does not lift it); hi = the lowest MAWP in the discharge circuit (`cj_mawp_n`, or the pump rating). ✗ if lo > hi.
- **Verdicts:** ✗ "Discharge circuit rated {MAWP} psig, below the shut-in wellhead pressure {SITHP} psig." for `wh`/`dh` when MAWP < SITHP; ✗ "SITHP exceeds the flowhead class." when SITHP > `cj_whclass`; ✗ when MAWP < P_rating.
- **Backflow (Summary ⚠, every pressurised line):** "Backflow: block valve, two check valves in series and a bleed at the tie-in. Size the tank vent for gas blow-by or fit a low-discharge-pressure trip; the pump PSV does not protect the tank."
- **Thermal relief:** a liquid-full section blocked in between the pump discharge check and the line block valve rises ΔP/ΔT ≈ α_v/β: methanol (α_v 6.6×10⁻⁴ /°F, β 8.6×10⁻⁶ /psi) **77 psi/°F**, so a 30 °F solar gain gives about 2,300 psi; water-based products ≈ 38 psi/°F; MEG ≈ 140 psi/°F [L]; hydrocarbon-solvent products ≈ 80 psi/°F [L]. The pump PSV does not protect a section isolated from it. Line result row plus Summary ⚠ "Thermal relief on any blockable liquid-full section, or a lock-open procedure."
- **Hydraulic power (electric):** hhp = Q (gpm)·P_req/1714.

Examples (H1): `wh` P_req 3550 psig, P_back 3500 → rating max(3905, 3650, 3850, 3600) = **3905 psig**, PSV set 3905 psig up to MAWP. `dsch` P_req 1050 psig, P_back 1440 → rating max(1155, 1150, 1584, 1540) = **1584 psig**, PSV ≥ 1440 psig.

#### 4.11.2 Downhole [H, physics; 3.2b]

- P_pump = P_tub(z) + P_CIV + ΔP_fric − 0.4335·SG_mean·TVD, with SG_mean the chemical SG at the mean of the tank (T_amb) and CIV temperatures: SG(T) = SG₆₀·(1 − α_v·(T − 60)).
- Flowing case: P_tub = `cj_dh_ptub`.
- Shut-in case: P_tub = the gas column below SITHP from `WTS_gradient_compute({dir:'s2b', p:SITHP, tvd, gasLen:tvd, mixLen:0, hl:0, rho:8.33, sg, t:T_avg, z:z_avg})`, with T_avg = (T_amb + T_CIV)/2 and z_avg from `WTS_gaspvt_z` at the mean column pressure (two passes). `rho` is required by the engine even for a pure gas column. `cj_dh_ggrad`, when entered, overrides this with SITHP + g·TVD.
- Design P_req = the maximum of the two; rating with P_back = SITHP (§4.11.1).

#### 4.11.3 Siphon / free-fall check

- Requirement: P_CIV ≥ 0.4335·SG_cold·TVD − P_tub,min, with SG_cold the maximum (coldest) SG along the line.
- ✓ if P_CIV ≥ 1.1 × the requirement; ⚠ between 1.0 and 1.1; ✗ below: "chemical column free-falls: set CIV ≥ X psi".
- Cross-check with `WTS_gradient_compute({dir:'b2s', p:P_tub,min + P_CIV, tvd, gasLen:0, mixLen:0, hl:100, rho:SG_cold·8.337, sg, t, z})`: when the column cannot be held it returns "Bottomhole pressure is too low to hold this column to surface…" (48-calc-wellkill.js L360).

#### 4.11.4 Capillary friction

- Laminar (Hagen–Poiseuille) below Re 2000: ΔP (psi) = **1.896×10⁻⁷**·μ (cP)·L_MD (ft)·Q (gal/d)/d_i⁴ (in). The 2000 threshold matches `WTS_flowline_friction.colebrook`, which returns 64/Re below 2000.
- Re = 7,738·SG·v·d_i/μ, with v (ft/s) = 2.837×10⁻⁴·Q/d_i².
- Re ≥ 2000: Darcy–Weisbach with `WTS_flowline_friction.colebrook`, resolved at call time.
- **Viscosity:** μ(T) = μ₆₈·exp(B·(1/T_K − 1/293.15)).
  - Methanol: Andrade A = −4.813, B = 1252.7 K (0.80 cP at 32 °F, 0.58 at 68 °F, 0.40 at 120 °F) [H].
  - MEG pure: B ≈ 4050 K, μ₆₈ 20 cP [M]. MEG 80 wt %: B ≈ 3200 K, μ₆₈ 9 cP [M].
  - Products: μ₆₈ from the DB with B = 2500 K [L] — "enter data-sheet viscosity".
  - MVP evaluates μ and SG at the mean of the tank and CIV temperatures; the siphon check uses the cold SG. The mean-T approach under-estimates cold glycol friction (the cold top section dominates): ⚠ "Glycol in a tank below 40 °F: friction is under-estimated; check at the coldest temperature" until the Phase 2 μ(T(z)) integration exists.
- **Capillary rating (screening, Barlow, 316 at 20 ksi):** 1/4 × 0.035 → 5,600 psi; 1/4 × 0.049 → 7,840; 3/8 × 0.049 → 5,230; 3/8 × 0.065 → 6,930. ✗ if below P_rating. "Verify against ASME B31.3 at temperature and the tubing certificate."

#### 4.11.5 Nozzle (Phase 2)

- d_o = √(4Q/(π·C_d·√(2ΔP/ρ))).
- ⚠ if d_o < 0.5 mm: "atomiser orifice would plug; use a plain quill in a high-velocity zone". Example: 2 L/h, 100 psi, ρ 1100 kg/m³, C_d 0.7 → 0.17 mm.

### 4.12 Field checks, tank and supply

#### 4.12.1 Drawdown cylinder

- Q (gal/d) = **22.8245**·ΔV (mL)/t (s); Q (mL/min) = 60·ΔV/t;
- ηv,actual = Q_meas/(n_h·V_s·SPM) (swept V_s);
- corrected SPM_new = SPM_old·Q_target/Q_meas, N_new = N_old·Q_target/Q_meas, or for the air-driven pump P_air,new from the curve at Q_target with Q₀ re-fitted to the measurement;
- cylinder ≥ 1.25·Q_peak·t_test (t_test 60 s), from 100, 250, 500, 1000, 2000, 4000 mL;
- expected drop in 30 s and 60 s; time to draw 100 mL.

#### 4.12.2 Tank and totes

- days = (V_tank − heel)/Q with heel 10 %;
- vertical tank level drop = Q/(5.875·D²) ft/d;
- test inventory = Q·days·1.2 (20 % contingency);
- totes on site = ceil(inventory/(0.9 × 275 gal)) for 275-gal totes; tote changes = totes on site − 1 (contingency included);
- ⚠ if days of supply < test duration: "plan {changes} tote changes or a larger tank".

#### 4.12.3 Drive gas (pneumatic and air-driven pumps)

- **Supply setting at the design pressure** (pneumatic plunger): P_s,set = max(20, n_h·P_d,design·A_pl/(η_m·A_act) + P_spr), with P_d,design = P_req (the shut-in case at `wh`/`dh`) and P_spr = 5 psi spring-return offset [L]. ✗ if P_s,set > `cj_psup`: "Drive gas {P} psig is too low to inject at the shut-in pressure: the pump stalls before the well is opened." Air-driven pump: the peak air setting from §4.10.3.
- **Gas per stroke (pneumatic):** A_act·L·(P_s,set + 14.7)/14.7/1728 (scf); scf/d = per stroke × SPM × 1440. Air-driven pumps: "use the pump's air-consumption curve" (not computed).
- **Drive-gas type (`cj_supgas`):**
  - `air`, `n2`: no greenhouse-gas line;
  - `sweet`, `well`: methane vented at the pump; scf/d shown next to the regulatory default 13.3 scf/h per natural-gas-driven pump (40 CFR 98 Subpart W, Table W-1A); Phase 2 "send to Flare & GHG";
  - `well` with H2S ≥ 10 ppm: ✗ "Do not drive pneumatic pumps with sour produced gas: use instrument air, nitrogen or sweet gas, or route the exhaust to flare. Exhaust carries {y} ppm H2S ({m} lb/d)." Below 10 ppm H2S: ⚠ with the same exhaust line.

### 4.13 Worked examples (tests check these; §7)

**H1 — hydrate, 10 MMscf/d gas well (page default).**

Inputs:
- q_g 10 MMscf/d, γ 0.65 sweet, q_w 2 bbl/d free water (SG 1.05), no condensate;
- FWHP 3000 psig / FWHT 110 °F, SITHP 3500 psig, T_amb 60 °F, choke to 1000 psig;
- heater 90 °F, separator 1000 psig, separator PSV 1440 psig, flowhead class 5000 psi, classified area, instrument air;
- margin 10 °F, J-T factor 1.10, neat methanol upstream of the choke, air-driven liquid pump.

| Step | Result |
|---|---|
| Choke outlet (3014.7 → 1014.7 psia) | DAK 41.42 °F; **design 34.56 °F** (1.4 °C) = 110 − 1.10 × 68.58; Peng–Robinson check 35.84 °F |
| T_hyd at 1014.7 psia; at 3014.7 psia (flowhead) | 63.13 °F (subcooling 28.57 → at risk); 78.58 °F (FWHT 110 → no risk while flowing) |
| Required ΔT = 63.13 − 34.56 + 10 | **38.57 °F** |
| X_R: Hammerschmidt 34.58 wt % (reference); Nielsen–Bucklin 38.14 wt % | **38.14 wt %** (x_MeOH 0.2574) |
| Water: W(3014.7, 110) 39.18 − W(1014.7, 34.56) 7.44 = 31.74 lb/MMscf × 10 | condensed **317.4 lb/d** (extrapolated below 60 °F, flagged) |
| Free water 2 × 350.2 × 1.05 | **735.4 lb/d**; total m_W **1052.8 lb/d** (478 kg/d) |
| Aqueous MeOH 1052.8 × 0.3814/0.6186 | **649.0 lb/d** |
| Vapour loss (K 1.898×10⁻³ at 1014.7 psia, 34.56 °F; 84,431 lb/MMscf per mole fraction) | **412.5 lb/d** (39 %) |
| Total | **1061.5 lb/d** (481.5 kg/d) = **159.95 gal/d** (ρ 6.636 lb/gal) = 605.5 L/d = 25.23 L/h = **420.5 mL/min** = 3.81 bbl/d = 15.99 gal/MMscf |
| J-T sensitivity | DAK unfactored (41.42 °F): 927.2 lb/d = 139.7 gal/d (−12.6 %); Peng–Robinson (35.84 °F): 1036.9 lb/d = 156.2 gal/d (−2.3 %) |
| Variants | Hammerschmidt (reference only): 923.6 lb/d · `all` condensed: 1107.3 lb/d · lean 95 wt % (rigorous): 1154.8 lb/d = 172.2 gal/d (old formula 1140.2) · +20 bbl/d condensate: f_c 0.331 lb/bbl → +6.6 lb/d · existing Hydrate page at the same ΔT: 191.6 cc/min ≈ 72.9 gal/d (2.2× lower) |
| With an S1-size MEA-triazine line upstream of the choke (30.95 gal/d, SG 1.11, 60 % water) | +171.8 lb/d water → m_W **1224.7 lb/d** → total **1167.4 lb/d** (+105.9 lb/d, +10.0 %) = 175.9 gal/d |
| MEG 80 wt % (X_R 54.42 wt % NB; Hammerschmidt 46.97 reference; glycol loss 0) | 2240 lb/d solution = **246.4 gal/d** (ρ 9.093 lb/gal; Hammerschmidt would give 164.6 gal/d) |
| Rich-phase freeze point (38.1 wt %) | ≈ −33.7 °F, below the 34.56 °F cold node ✓ |
| Pressure | P_req = max(3500, 3000) + 50 = **3550 psig**; P_back = SITHP 3500; rating ≥ **3905 psig**; PSV set between 3905 psig and the circuit MAWP |
| Pneumatic plunger (4/6/8 in actuators, 100 psig, 60 SPM max, peak 2×) | **No feasible option.** 4 in, 1/2 × 1 in: 145.2 SPM (242 %) rate · 4 in, 3/4 × 1: P_max 2,276 and rate · 6 in, 3/4 × 1: 64.5 SPM (108 %) rate · 8 in, 1 × 1: 36.3 SPM (60 %), peak 121 % rate · 8 in, 3/4 duplex: P_max 4,551 ✓, peak 108 % rate · 8 in, 1 in duplex: P_max 2,560 pressure |
| **Air-driven liquid pump (default)** (Q₀ 30 gal/h = 720 gal/d, ratio 100:1, air 100 psig → stall 10,000 psig, 1.0 in³/cycle) | Flow at 3550 psig with full air **464.4 gal/d** ≥ peak 319.9 ✓; P_req/P_stall 0.355 ≤ 0.7 ✓. **Air setting 45.6 psig** (peak 63.9 psig); **25.7 cycles/min** (peak 51.3); stall at the design setting 4,560 psig → the discharge PSV is the protection; set and verify by drawdown cylinder |
| Electric plunger (alternative; 120 SPM crank, 1 in max stroke, 2,500 lbf, ηv 0.9) | **7/8 in, 1 head: 39.5 % stroke** (peak 79.0 %), P_max 4,158 ✓; 3.89 mL/stroke swept at this setting, **3.50 mL delivered**; alternatives duplex 5/8 in 38.7 %, duplex 3/4 in 26.9 %; hydraulic power 0.23 hp at P_req (0.25 hp at the rating); ⚠ certified motor in the classified area |
| Field check | 420.5 mL/min → 210 mL in 30 s, 420 mL in 60 s; cylinder ≥ 1,051 mL → **2000 mL** |
| Supply | 275-gal tote (247.5 gal usable) → **1.55 d** ⚠ for a 5-day test; 960 gal for the test (+20 %) → **4 totes on site, 3 tote changes** (contingency included) |
| Second expansion (3.2b; `cj_pbpv` 250 psig, from 90 °F) | DAK 47.51 °F, **design 43.27 °F** vs T_hyd 44.06 °F → **✗ inside the hydrate region** (0.8 °F); separator gas 44.83 → 28.42 lb/MMscf, 164.1 lb/d of water condenses; ΔT 10.79 °F → MeOH 13.38 wt %; dose at `sepgas` 25.3 lb/d aqueous + 345.5 lb/d vapour loss = 370.8 lb/d (55.9 gal/d) → vapour loss is 93 %, so heating or a smaller drop is the better fix |
| Start-up (60 °F tree, 3514.7 → 1014.7 psia) | DAK −18.81 °F, design **−26.69 °F**; ΔT 99.81 °F → MeOH **67.36 wt %** (NB) → ⚠ chemical-only inhibition marginal (start-up advice shown) |
| Shut-in (SITHP, 60 °F) | ΔT 30.76 °F → MeOH 32.27 wt %; MEG 47.99 wt % (NB) |
| Heater alternative (Phase 2) | pre-heat to **142.1 °F** upstream of the choke removes the chemical need (DAK alone 136.9 °F) |
| LDHI screen (3.2b) | KHI 1.83 gal/d, but max subcooling 89.8 °F (start-up; flowing 28.6, shut-in 20.8) → **KHI ✗**; AA ✗ (no liquid hydrocarbon) |

**S1 — H2S scavenger (3.2b).**

Inputs:
- 5 MMscf/d, γ 0.65, 50 → 4 ppm;
- MEA-triazine 40 % active, SG 1.11, η 0.58, 60 % water, upstream of the choke;
- FWHP 985 psig / 100 °F, SITHP 1500 psig, choke to 300 psig, separator 285 psig (PSV 720 psig), heater outlet 100 °F;
- pneumatic plunger, 4 in actuator; drive gas set to produced well gas (to show the ✗).

Results:
- **Removed:** 20.656 lb/d (9.37 kg/d), equal to `WTS_h2s_scavenger`.
- **Ratio:** R_th 0.8691 gal/lb; R = 1.4984 gal/lb (13.9 lb product/lb).
- **Rate:** **30.95 gal/d** = 117.2 L/d = 4.88 L/h = **81.4 mL/min**.
- **SO2 at the flare (CE 98 %):** 1.7234 lb/h untreated → 0.1379 lb/h treated; **SO2 avoided 38.05 lb/d**.
- **Choke outlet:** DAK 63.55 °F, design **59.90 °F** vs T_hyd(314.7 psia) 46.51 °F → no hydrate risk, so the aqueous scavenger needs no THI cross-check here.
- **Contact time** (Z from `WTS_gaspvt_z`): 20 ft/2.900 in at 999.7 psia, 100 °F (Z 0.871); 60 ft/3.826 in at 314.7 psia, 59.9 °F (Z 0.945); 200 ft/2.900 in at 309.7 psia, 100 °F (Z 0.958); 80 ft/3.826 in at 299.7 psia, 100 °F (Z 0.959) → v = 17.4 / 32.0 / 61.7 / 36.7 ft/s, t = 1.15 + 1.88 + 3.24 + 2.18 = **8.45 s** → ⚠ below 15 s. Highest v/v_e 62 % (heater coil) ✓. (The earlier 135-psig case gave 135.6 ft/s in the coil, 92 % of v_e.)
- **Pressure:** P_req 1550 psig; P_back 1500 → rating ≥ 1705 psig.
- **Pneumatic plunger:**
  - 1/2 × 1 in: **28.10 SPM** (46.8 %, peak 42.1 = 70.2 %), P_max 5,120 ✓ → recommended;
  - 3/8 × 1: 49.95 SPM (83 % amber, peak 74.9 > 51) → infeasible.
- **Drive gas:** P_s,set at the shut-in design pressure = 1550 × (0.5/4)²/0.8 + 5 = **35.3 psig** ≤ 100 ✓ (a setting from the flowing 1035 psig, 25.2 psig with the offset, would stall before the well is opened); 0.02472 scf/stroke → **1,000 scf/d (41.7 scf/h)** vs the 13.3 scf/h default. Drive gas = produced gas with 50 ppm H2S → **✗**; the exhaust carries 50 ppm H2S (0.0045 lb/d).
- **Supply:** tote 8.00 d ✓; 186 gal for 5 d (+20 %) → 1 tote.

**S2 — large H2S load (3.2b).** 10 MMscf/d, 500 → 4 ppm.
- Removed 445.5 lb/d. At 1.5 gal/lb: 668 gal/d (1.76 L/min).
- ⚠ "High H2S load (> 200 lb/d): consider a contactor vessel or an alternative treatment; liquid direct injection is commonly economic only below about 100–200 lb/d [L]". 3/8 in pneumatic is ✗; options: air-driven liquid pump, electric plunger or skid.

**P1 — pump fixtures.**
- Methanol 30 gal/d, 3/8 × 1 in, ηv 0.9 → 78.86 mL/min, **48.41 SPM** (1.239 s/stroke, 12.10 per 15 s); 1/2 in → 27.23 SPM.
- Calibration: 72 mL in 60 s at 48 SPM → 27.39 gal/d, ηv 0.8288, **52.58 SPM**.
- Tote 275 gal at 30 gal/d → 8.25 d. A 4 ft vertical tank drops 3.83 in/d.

**P2 — electric metering.** Triazine 2 L/h on a 10 L/h pump.
- 33.33 mL/min, 12.68 gal/d, f 0.20 → **40 % stroke × 50 % speed** (60 pulses/min, 0.556 mL/stroke at a 120 SPM pump); alternative 50 × 40.
- Calibration reads 36.0 mL/min at 50/40 → speed **37.04 %**.
- 0.3 L/h on the same pump: f 0.03 < max(0.10, 0.02) → S 20 / N 15 with ⚠ turndown.

**D1 — downhole (3.2b).** CIV at 8000 ft TVD / 8500 ft MD; 1/4 × 0.049 capillary (ID 0.152 in); methanol SG₆₀ 0.796 (α_v 6.6×10⁻⁴ /°F), 30 gal/d; tank 60 °F, CIV 180 °F; P_tub 2800 flowing, 1500 minimum; SITHP 3500 psig; CIV set 1500 psi.
- Mean temperature 120 °F → SG 0.7645, μ 0.397 cP (computed, not forced).
- Hydrostatic 0.4335 × 0.7645 × 8000 = **2,651.4 psi**; friction **36.0 psi** (Re 834, laminar).
- Shut-in tubing pressure at depth: gas column from `WTS_gradient_compute` (z̄ 0.878 at 120 °F) = **4,242.2 psig** (0.093 psi/ft; the 0.08 psi/ft override would give 4,140).
- Flowing **1,684.6 psig**; shut-in **3,126.8 psig** → P_req 3,126.8 psig.
- Rating ≥ max(3,439.5, 3,226.8, 3,850, 3,600) = **3,850 psig** (the old rule gave 3,253.5, below SITHP); PSV set ≥ 3,500 psig; capillary 7,840 psi ✓.
- Siphon (cold SG 0.796): need 1,260.7 psi (× 1.1 = 1,386.7) → CIV 1500 ✓; CIV 1000 → ✗ free-fall.
- Viscosity-forced cases (pure friction function): MEG 80 wt % at 15 cP, 30 gal/d, 10,000 ft of the same line → 1,598 psi; methanol at 0.6 cP → 63.9 psi.
- Blocked-in methanol: 77 psi/°F.

**B1 — batch (3.2b).**
- Fill to the choke (segment 1, 20 ft × 2.9 in) + 10 gal tree → **16.86 gal**; to the heater inlet (segments 1–2) → 52.70 gal.
- Pill in 2.441 in tubing to 3000 ft (`WTS_tubulars.capacity`) → **17.36 bbl** (729 gal).

---
## 5. Databases (generic names only)

All values are planning defaults, editable on the page. "Use the product data sheet / supplier figure" is shown where confidence is [L]. SG is at 60 °F. μ₆₈ is viscosity at 68 °F (cP). Water % is the water mass fraction of the product as supplied (§4.4); for thermodynamic inhibitors the lean water is handled by X_L instead. Point keys are as in §3.1, ranked.

### 5.1 Chemicals (`WTS_chemlib.chemicals`)

| key | Generic name | Family | Dose basis | Default | Range | SG | μ₆₈ | Water % | Points (ranked) | Cautions (short) | Conf. |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `meoh` | Methanol | THI | wt_water (auto) | lean 100 wt % | lean 90–100 | 0.796 | 0.58 | via X_L | wh, dh, dsch, sepgas | Flash point 52 °F, near-invisible flame, toxic (TLV 200 ppm, skin); vapour loss high; methanol-rich produced water is flammable; with high-TDS brine can precipitate halite/carbonate; precipitates some scale inhibitors; flooded suction, shaded tank | H |
| `etoh` | Ethanol | THI | wt_water | lean 95 | 90–100 | 0.794 | 1.2 | via X_L | wh, dh, dsch | Flammable; denatured grades may contain methanol | M |
| `meg` | Monoethylene glycol (MEG) | THI | wt_water | lean 80 | 60–100 | 1.116 (pure) | 20 | via X_L | wh, dh, dsch | Viscous when cold (size tubing for T_min); pure freezes at 9 °F; toxic if swallowed | H |
| `deg` | Diethylene glycol (DEG) | THI | wt_water | lean 90 | 80–100 | 1.118 | 36 | via X_L | wh, dh | Limited validation; high ingestion toxicity | M |
| `teg` | Triethylene glycol (TEG) | THI (dehydration) | wt_water | lean 95 | 90–100 | 1.125 | 49 | via X_L | wh | Dehydration glycol, rarely injected; ⚠ | L |
| `khi` | Kinetic hydrate inhibitor (water-soluble polymer, e.g. vinyl-caprolactam type, in glycol-ether carrier) | LDHI | vol_water | 1.5 | 0.5–3 | 1.00 | 30 | 30 [L] | wh, dh, dsch | Subcooling ≤ 15 °F (27 °F advanced) over flowing, shut-in and start-up; hold time vs shut-in; cloud point at hot points; qualify | M |
| `aa` | Anti-agglomerant (quaternary-ammonium surfactant type) | LDHI | vol_water | 2.0 | 0.5–3 | 0.95 | 20 | 10 [L] | wh, dh, dsch | Needs liquid HC, water cut ≤ 50 %; emulsions; aquatic toxicity; qualify | M |
| `h2s_mea_triazine` | MEA-triazine, 40–50 % aqueous | Aqueous scavenger | gal_lb_h2s | stoich: MW 219.28, n 2, active 40 %, η by point | R 0.9–2.2 gal/lb | 1.11 (1.08–1.13) | 10 | 60 | wh, dsch, sepin, sepgas | Dithiazine solids if over-spent or at low velocity; raises pH → CaCO3 scale; water adds to hydrate load; aquatic toxicity; best 80–120 °F | H |
| `h2s_mma_triazine` | MMA-triazine | Aqueous scavenger | gal_lb_h2s | MW 129.21, n 2, 40 %, η 0.55 → 1.0 gal/lb | 0.6–1.6 | 1.03 | 5 | 60 | wh, dsch, sepin, sepoil | More volatile, hydrolysis-resistant; use supplier figure | L |
| `h2s_glyoxal` | Glyoxal 40 % | Aqueous scavenger | gal_lb_h2s | MW 58.04, n 1 (assumed), 40 %, → 1.0 gal/lb | 0.5–2.5 | 1.27 | 10 | 60 | wh, sepin, sepwat, sepoil | Acidic (pH 2–3.5): stainless wetted parts; slow; no scale | L |
| `h2s_aldehyde_blend` | Formaldehyde-releaser blend (hemiformal / oxazolidine) | Aqueous scavenger | gal_lb_h2s | 1.2 | 0.6–2.0 | 1.10 | 10 | 50 [L] | wh, dsch, sepin, sepoil | Formaldehyde hazard; use supplier figure | L |
| `h2s_oil_soluble` | Oil-soluble amine-aldehyde scavenger | Oil-phase scavenger | ppm_per_ppm_liq | 8 | 3–20 | 0.95 | 20 | 0 | sepoil, tank, wh | For crude/condensate H2S; use supplier figure | L |
| `h2s_zinc` | Zinc carboxylate (oil-soluble) | Oil-phase scavenger | gal_lb_h2s | 1.9 | 1.6–3.0 | 1.00 | 30 | 0 | sepoil, tank, wh | ZnS fines stabilise emulsions; discharge limits | M |
| `h2s_nitrite` | Sodium nitrite 30 % | Water oxidiser | gal_lb_h2s | 0.4 | 0.25–0.8 | 1.20 | 2 | 70 | sepwat (tank: N) | Oxidiser: never with organics or amines; with acidic sour water can release NOx; sulfur deposits; never block in | L–M |
| `h2s_peroxide` | Hydrogen peroxide 35 % | Water oxidiser | gal_lb_h2s | 0.4 | 0.3–1.4 | 1.13 | 1.1 | 65 | sepwat (tank: N) | Strong oxidiser: decomposes to O2 (flammable atmosphere in a hydrocarbon vapour space; overpressure when blocked in); vented, non-hydrocarbon tank only; water only | M |
| `ci_film_liq` | Film-forming corrosion inhibitor (imidazoline / fatty amine / quaternary in solvent) | Corrosion | ppmv_liq | 25 | 10–100 | 0.92 | 20 | 0 | dh, wh, dsch, sepin | Overdose → emulsion/foam; cationic + anionic scale inhibitor precipitate neat; flammable solvent | M |
| `ci_water` | Water-soluble corrosion inhibitor | Corrosion | ppmv_water | 50 | 20–200 | 1.03 | 10 | 60 [L] | dh, wh, sepin | Check compatibility | M |
| `ci_gas` | Gas-well corrosion inhibitor (atomised) | Corrosion | pt_mmscf | 1.0 | 0.25–2 | 0.92 | 20 | 0 | wh, dh, dsch | Atomise; batch per supplier procedure | L–M |
| `si_phosphonate` | Phosphonate scale inhibitor | Scale | ppmw_water | 10 | 2–50 | 1.20 | 10 | 60 [L] | dh, wh, dsch, sepin | Dose 1.5–2 × MIC (MIC is ppm active); high Ca → Ca-phosphonate; high methanol → inhibitor precipitation; acidic forms pH 1–3 | M |
| `si_polymer` | Polymeric scale inhibitor | Scale | ppmw_water | 15 | 5–50 | 1.15 | 15 | 60 [L] | dh, wh, dsch | Sulfate scales; more MEG-tolerant | M |
| `af_silicone` | Silicone antifoam (PDMS in solvent) | Antifoam | ppmv_oil | 5 | 1–30 | 0.95 | 50 | 0 | sepin, dsch | Silicon poisons refinery catalysts (buyer's Si limit); dilute (tiny rates) | M |
| `af_nonsilicone` | Non-silicone antifoam (polyglycol / alcohol) | Antifoam | ppmv_oil | 20 | 5–100 | 0.98 | 30 | 0 | sepin, dsch | Overdose stabilises foam | M |
| `demulsifier` | Demulsifier (oxyalkylated resin / polyol blend in aromatic solvent) | Emulsion | ppmv_oil | 30 | 5–200 | 0.94 | 30 | 0 | wh, dh, dsch, sepin | Bottle-test; overdose re-stabilises; flash point often < 100 °F | M |
| `water_clarifier` | Water clarifier (cationic polymer) | Emulsion | ppmv_water | 10 | 2–50 | 1.05 | 50 | 60 [L] | sepwat, sepin | Only where water is discharged | M |
| `paraffin_inhibitor` | Wax inhibitor (EVA / polyacrylate comb polymer) | Wax | ppmv_oil | 200 | 50–1000 | 0.90 | 50 | 0 | dh, wh, dsch | Inject above WAT (+10–20 °F); product pour point (winterised grade) | M |
| `ppd` | Pour-point depressant | Wax | ppmv_oil | 300 | 100–2000 | 0.90 | 50 | 0 | sepoil, wh, dsch | Same as wax inhibitor | M |
| `asphaltene_inhibitor` | Asphaltene inhibitor / dispersant (alkylphenol resin / polyisobutylene succinimide) | Asphaltene | ppmv_oil | 200 | 50–1000 | 0.92 | 20 | 0 | dh, wh | Below the onset-pressure depth; qualify on live oil | M |
| `biocide` | Biocide (glutaraldehyde / THPS / quaternary) | Water systems | ppmv_water | 250 (batch) | 50–1000 | 1.10 | 5 | 50 [L] | sepwat, tank | Not normally used in a flowing test | M |
| `o2_scavenger` | Ammonium bisulfite 65 % | Water systems | ppm_per_ppm_o2 | 10 | 8–15 | 1.35 | 5 | 35 | tank, sepwat | Not normally used in a flowing test; never with aldehydes | M |
| `custom` | Custom chemical | – | any (user) | – | – | user | user | user | user | Enter the data-sheet values | – |

Not in the dropdown (Notes only): caustic scrubbing (consumed by CO2), iron-oxide beds (vessel sizing), drag reducer (export lines only).

Each record also carries:
- `water` (mass fraction) and `activeDef`;
- `beta` (psi⁻¹) and `alphaV` (1/°F), giving the blocked-in pressure rise α_v/β and SG(T);
- `muB` (K);
- `flashF` (°F) and `freezeF`/pour point;
- `oxidiser` (bool);
- elastomer flags (§5.5);
- `incompat` tags (§5.4);
- `stoich` for scavengers;
- `leanDef`;
- `effByPoint` for scavengers.

### 5.2 Pumps (`WTS_chemlib.pumps`) — generic presets, illustrative, all editable

| key | Generic type | Setting output | Plungers / capacity | Stroke | SPM | Pressure limit | Turndown / accuracy | Classified area | Best-fit points | Conf. |
|---|---|---|---|---|---|---|---|---|---|---|
| `pneu_plunger` | Pneumatic plunger pump (gas/air actuator, single-acting; 1 or 2 plungers on one actuator) | SPM | 3/16–1 in; actuator 4, 6 or 8 in | 1/4–1 in (default 1) | max 60 (some families 25–30: edit), min stable 3 | P_max = η_m·P_s·A_act/(n_h·A_pl); body 10,000 psi | ~10–20:1 speed × ~3:1 stroke; ±5–10 % uncalibrated, ±2–5 % after drawdown calibration | suitable (vents drive gas) | wh, dsch, sepin, dh (small plunger) | M |
| `air_liquid` | Air-driven liquid pump (pressure amplifier) | air pressure setting; cycles/min | Q(P) = Q₀·(1 − P/(r·P_air)), Q₀ 30 gal/h (0.5 gpm); 1.0 in³/cycle | self-cycling | – | P_stall = r·P_air (100:1 × 100 psig = 10,000 psi); body 10,000 psi | not a metering pump: drawdown cylinder or meter mandatory; operate ≤ 0.7·P_stall; design ≥ 0.1·Q₀ | suitable (no electrics; vents drive gas) | wh, dh, high-pressure batch/start-up | M |
| `elec_plunger` | Electric packed-plunger metering pump (API 675 class) | % stroke (× % speed with VFD) | 1/4–1 in (1-1/4 optional), heads 1–3 | max 1 in, 10–100 % | crank 120 (30–180) | F_rod/A_pl, rod 2,500 lbf, cap 15,000 psi | ±1 % over 10:1 (API 675) | certified motor needed (⚠) | wh, dh, any HP point | M |
| `elec_hyd_diaph` | Hydraulically-actuated diaphragm metering pump (API 675 class) | % stroke × % speed | rated 5 gal/h (120 gal/d) | 10–100 % | 120 | 3,000 psi | ±1 % over 10:1 | certified motor needed (⚠) | dsch, sepin, moderate wh | M |
| `elec_solenoid` | Electric solenoid diaphragm metering pump | % stroke × % pulse rate | rated 10 L/h (63.4 gal/d) | 20–100 % | pulse ≤ 120 | 150 psi | ~100:1 combined; ±2 % repeatability | certified unit needed (⚠) | tank or low-pressure points; separator outlets only when P_sep + allowance < P_max | M |
| `elec_mech_diaph` | Motor-driven mechanical diaphragm metering pump | % stroke × % speed (VFD) | rated 20 gal/h | 10–100 % | 30–180 | 250 psi | 10:1 stroke | certified motor needed (⚠) | tank or low-pressure points; separator outlets only when P_sep + allowance < P_max | M–L |
| `air_diaph` | Air-operated diaphragm transfer pump | cycles/min | ≈ 300 gal/h free flow | – | ≤ 200 | ≈ supply pressure (1:1) | coarse | suitable | tank transfer, atmospheric dosing | M–L |
| `hand` | Hand pump (batch) — Phase 2 | strokes for batch | 1.0 in³/stroke | – | – | 10,000 psi | batch only | suitable | pre-start fill | L |

The engine's pressure check, not this column, decides whether a point is feasible (e.g. at H1's 1000 psig separator neither the solenoid nor the mechanical diaphragm pump can inject at the separator outlets). Plunger, stroke and capillary lists: §2.3. Pump records carry:
- `kind` (`plunger` | `meter` | `airliquid` | `transfer` | `hand`);
- `spmMax`, `spmMin`, `sMin`, `nMin`, `vfd`;
- `pmaxRule` (`pneumatic` | `rod` | `fixed` | `ratio`);
- `bodyPsi`, `actuators` (pneumatic), `q0`, `ratio`, `vcyc` (air-driven);
- `etaDef`;
- `vents` (bool), `electric` (bool, drives the hazardous-area ranking);
- `hazAreaNote`.

### 5.3 Capillary / control lines (`WTS_chemlib.capillary`)

| key | OD × wall (in) | ID (in / mm) | Barlow 316 @ 20 ksi (psi) |
|---|---|---|---|
| `c250_035` | 1/4 × 0.035 | 0.180 / 4.57 | 5,600 |
| `c250_049` | 1/4 × 0.049 | 0.152 / 3.86 | 7,840 |
| `c375_049` | 3/8 × 0.049 | 0.277 / 7.04 | 5,230 |
| `c375_065` | 3/8 × 0.065 | 0.245 / 6.22 | 6,930 |

### 5.4 Compatibility rules (`WTS_chemlib.compat`)

The engine checks every pair of active lines at the same point and every pair sharing a tank (Phase 2: a tank-id field). Each verdict is under 300 characters.

| Pair (tags) | Level | Verdict text (short) |
|---|---|---|
| any organic + oxidiser (nitrite, peroxide, hypochlorite) | ✗ | Never in the same line or tank: violent reaction, chemical destroyed |
| oxidiser + hydrocarbon tank or vapour space | ⚠ | O2 / NOx evolution into a hydrocarbon vapour space: vented, non-hydrocarbon tank only |
| triazine / amine + nitrite | ✗ | Never together: possible nitrosamines; nitrite consumed |
| aldehyde (glyoxal, glutaraldehyde, releaser blends) + bisulfite | ✗ | Do not dose together: bisulfite adducts deactivate both |
| triazine + glyoxal / aldehyde | ⚠ | Separate injection points |
| triazine + acidic scale inhibitor | ⚠ | Separate lines; neat mixing precipitates |
| cationic corrosion inhibitor or clarifier + anionic scale inhibitor | ⚠ | Separate quills several pipe diameters apart |
| methanol (high fraction) + scale inhibitor | ⚠ | Inhibitor salts may precipitate; test compatibility (MEG milder) |
| corrosion inhibitor / demulsifier + antifoam | ⚠ | Bottle-test the package; overdose reverses effect |
| triazine + produced water with Ca/bicarbonate | ⚠ | CaCO3 scale and emulsions: add scale inhibitor, avoid overdosing |
| silicone antifoam + crude for sale | ⚠ | Check the buyer's silicon limit |
| glyoxal + carbon steel wetted parts | ⚠ | Stainless wetted parts and corrosion inhibitor |
| aqueous scavenger at `sepgas` with no knock-out | ⚠ | Liquid carry-over to the flare |

### 5.5 Elastomer screening (A good / B fair / C poor) [M–L]

| Chemical | NBR | HNBR | EPDM | FKM std | FKM peroxide | FFKM | PTFE |
|---|---|---|---|---|---|---|---|
| Methanol | B | B | A | C | A-B | A | A |
| MEG / glycols | A | A | A | A | A | A | A |
| MEA-triazine | B | B | A | C | B-C | A | A |
| Oil-soluble corrosion inhibitor (aromatic solvent) | B | B | C | A | A | A | A |
| Aqueous acidic scale inhibitor | A-B | A | A | A-B | A | A | A |
| KHI in glycol-ether solvent | B-C | B | A-B | C | B | A | A |

Shown as a plain-text line per line result: "Seals: avoid standard FKM with methanol; use rapid-gas-decompression-rated grades in gas service above ~1000 psi."

---

## 6. Code architecture

### 6.1 Files

| File | Round | Contents |
|---|---|---|
| `prism-build/40-calc-chemlib.js` (new) | 9 (auto-discovered; sorts before `40-calc-tubulars.js`) | Data-only module: `window.WTS_chemlib = {version, chemicals[], pumps[], points[], plungers[], strokes[], actuators[], capillary[], bases{}, compat[], elastomer{}, find(key), list(family), suit(chemKey, pointKey) → 'R'\|'A'\|'N'\|'X', pump(key)}`. No registry entry, no DOM. Header comment as in 40-calc-tubulars.js L9 ("data module: does not add a page to window.WTS_calcRegistry"), so `concat-round9.js` does not warn on every build. |
| `prism-build/49-calc-cheminj.js` (new) | 9 (sorts first among the 49s: "che" < "cho") | Page + pure engines + registry entry. Engines in later files (lineheat, flowline) are resolved at call time (`G.WTS_flowline_friction` inside functions), never captured at load. |
| `prism-build/46-calc-gaspvt.js` (additive edit) | 9 | New exports, all with impurities in mol % like `compute()`: `WTS_gaspvt_z({sg, p, t, co2, h2s, n2})` → `{ok, z, Bg_ft3scf, Tpr, Ppr, warnings}` (p psia, t °F; no −40 °F floor, only T_pr ≥ 1; built from `pseudoCriticals` + `PRiSM_pvt_correlations.Z_dranchukAbouKassem`); `WTS_gaspvt_enthalpy({sg, p, t, co2, h2s, n2})` → `{ok, h_Jmol, hRes_Jmol, cp_JmolK, z}`; `WTS_gaspvt_isenthalpic({sg, p1, t1, p2, co2, h2s, n2})` → `{ok, t2, dT, iterations, warnings}` with `.stats()`. `compute()` is unchanged, so the gaspvt tests are untouched. |
| `prism-build/tests/calc-cheminj.test.js` (new) | – | WP `CHEM` (§7) |
| Host `well-testing-app.html` (small) | – | `'cheminj'` in `__NAV_ORDER` (Option A) or the hub edits (Option B, §2.7); `RT_BUILTIN` (§6.6); the `chem` page cross-link line; `RELEASE_NOTES` item and version bump (§7.4) |
| `prism-build/25-hydrate.js` (one line, Round 5, subject to Q2) | 5 | The `rp-skip` banner (§2.7) |
| `prism-build/smoke-test.js` | – | `['cheminj','WTS_cheminj_compute']`, a `WTS_chemlib` shape check, `WTS_gaspvt_z` and `WTS_gaspvt_isenthalpic` |
| `prism-build/tests/sidebar-nav.test.js` | – | Option B only: HUBS + the new hub and its tab labels |
| `prism-build/tests/platform-reports.test.js` | – | Only if `cheminj` is placed inside the final template's list rather than appended (§6.6) |

Rejected: putting the new hydrate design engine into `25-hydrate.js` in the MVP. That would change the G4 expected numbers. It is left as an open question for Phase 2 (Q2).

### 6.2 Registry entry

```js
G.WTS_calcRegistry = G.WTS_calcRegistry || {};
G.WTS_calcRegistry.cheminj = {
  key: 'cheminj',
  title: 'Chemical Injection',
  sub: 'Hydrate inhibitor, H2S scavenger and treating-chemical dosing per injection point, with pump settings',
  group: 'Test System Safety',
  icon: '&#128167;',
  desc: 'Plan where to inject, how much, and the pump stroke, speed or air setting for every chemical on the spread.',
  hooks: { silent: true, after: function (body) { _syncUi(body); window.calcChemInj(); } },
  render: renderChemInj                    // window.renderChemInj also exported
};
```

`navTitle` (same as the title) and `badge`/`bc` are omitted: the host's group tile mapping (`__CALC_GROUP_TILE`) already gives "Safety" / `dc-b-orange` for this group. `__mountCalcNav` copies `hooks` into `PAGE_HOOKS`; the host honours `hook.silent` and `hook.after` during restore (L1330-1340).

### 6.3 Pure engine API (field units in and out)

One namespace object, `window.WTS_cheminj` (precedent: `WTS_flowline_friction`, `WTS_tubulars`), plus `window.WTS_cheminj_compute` for the registry contract and the smoke check. This keeps to the per-plug-in prefix convention, avoids about 20 flat globals that read like the host `chem` page (`calcChem`, `addChem`, `_chemRows`), and gives the units layer's `_wrapEntryPoints` fewer window keys to walk.

Every function:
- returns `{ok:false, errors[], bad[]}` on bad input (h2sroe convention);
- returns `warnings[]` and `verdicts[]` items `{level:'ok'|'warn'|'bad', text}`, plain text under 299 characters;
- touches no DOM and starts no timers.

| Function | Input | Output (main fields) |
|---|---|---|
| `WTS_cheminj.pvWater(tF)` | °F | psia (Wagner–Pruss) |
| `.waterContent(pPsia, tF)` | psia, °F | `{ok, W_lbMMscf, pv, inRange, warnings}` |
| `.depression(key, W, method)` / `.requiredWt(key, dT, method)` | key ∈ meoh/etoh/meg/deg/teg; method auto/ham/nb | ΔT °F / `{W, W_ham, W_nb, methodUsed, outOfRange}`; Hammerschmidt through `WTS_hammerschmidt_*` via the key map (§4.3) |
| `.methanolLoss(pPsia, tF, W, vm)` | | `{K, x, lbPerMMscf, inRange}` |
| `.spread(i)` | stream + spread inputs (§2.3) | `{ok, nodes:[{key,label,p_psia,t_F,tDak_F,thyd,sub,status,z,Bg,v_fts}], shutin:{…}, startup:{…}, bpv:{…}}` using `WTS_gaspvt_isenthalpic` × f_JT, `WTS_gaspvt_z`, `WTS_hydrate_temp` |
| `.hydrateDose(i)` | `{qg, sg, h2s_ppm, co2, n2, qw, sgw, wbasis, qo, api, nodes, injPoint, inhibitor, leanPct, method, margin, sourPerMol, thydUser?, condensed, fcRef, glyLossPct, rho, otherWater:[{point, lb_d}]}` | `{ok, control, dT, marginUsed, XR, XR_ham, XR_nb, methodUsed, x, water:{free,cond,other,total,Win,Wout}, inh:{aq,vap,lhc,solution_lb_d,gal_d,L_d,L_hr,mL_min,bbl_d,gal_MMscf,kg_d}, freezeF, startup:{dT,XR,verdict}, shutin:{dT,XR}, second:{…}, verdicts}` |
| `.ldhiDose(i)` | `{kind, dosePct, qwCtrl_bpd, subFlow, subShutin, subStartup, holdH, shutinH, hasLHC, waterCut}` | `{gal_d,…, subMax, failingCase, verdicts}` |
| `.scavRatio(i)` | `{mw, nH2S, activePct, sg, eff}` | `{theo_galPerLb, galPerLb, lbProdPerLb, effClamped}` |
| `.scavengerDose(i)` | `{qg, yin, yout\|targetKey, so2Allow, ce, ratio\|stoich, liq:{qo,sgo,ppmwO,qw,sgw,ppmwW}, point}` | `{ok, gas: WTS_h2s_scavenger(...) or null, liq_lb_d, removed_lb_d, gal_d, L_d, L_hr, mL_min, so2Before_lbhr, so2After_lbhr, so2Avoided_lb_d, pp_psia, verdicts}` (guards in §4.8) |
| `.contactTime(i)` | `{qg, sg, co2, h2s_ppm, n2, segments:[{len_ft, id_in, p_psia, t_F}]}` | `{ok, segments:[{z,Bg,v_fts,ve_fts,t_s}], total_s}` (`WTS_gaspvt_z` per segment) |
| `.doseRate(i)` | `{basis, dose, activePct, qo, qw, qg, sgo, sgw, sgc, qwCtrl}` | `{gal_d, L_d, L_hr, mL_min, bbl_d, activePpm}` |
| `.pumpSetting(i)` | `{rate_gal_d, pump (preset merged with line overrides), plunger_in, stroke_in, heads, actD_in, eta, spmMax, qRated, pmax, q0, ratio, vcyc, rod, psup, peakF, minF, pRating, pReq, bands}` | plunger: `{Vs_in3, Vs_mL, del_mL, spm, spmPeak, spmMin, pct, band, sPerStroke, per15, pMax, pOk, feasible, why}`; meter: `{f, S, N, pulse, mLperStroke, band, alt:{S,N}, pMax, pOk, feasible, why}`; air-driven: `{qAtPreq, airDesign, airPeak, cyclesMin, pStallDesign, feasible, why}` |
| `.pumpOptions(i)` | same + candidate lists + `haz` | `{ranked:[…top 3], current, nextPlunger, reason}` (§4.10.6) |
| `.injectionPressure(i)` | `{point, sithp, fwhp, pck, psep, pbpv, psvsep, whclass, rateBasis, dpq, marginPct, marginAbs, mawp, downhole:{tvd, md, ptub, ptubMin, ggrad?, civ, capId, sg60, alphaV, mu68, muB, tTank, tCiv, rate_gal_d, gasSg, co2, h2s_ppm, n2}}` | `{ok, pLine, pBack, breakdown:{line, allowance, friction, hydrostatic, civ}, pReqFlow, pReqShutin, pReq, pRating, psvBand:{lo,hi}, siphon:{need, ok}, cap:{Re, regime, dp, rating}, dPdT_psiF, verdicts}` |
| `.capillaryFriction(i)` | `{q_gal_d, md_ft, id_in, mu_cP, sg}` | `{dp_psi, Re, v_fts, regime}` |
| `.calibration(i)` | `{mL, s, setting, kind, Vs_mL, heads, target_gal_d, airCurve?}` | `{gal_d, mL_min, etaActual, newSetting, withinPct}` |
| `.tank(i)` | `{V_gal, heelPct, rate_gal_d, days, toteGal}` | `{days, inventory_gal, totes, toteChanges}` |
| `.supplyGas(i)` | `{kind, actD_in, stroke_in, heads, spm, pdDesign_psig, plunger_in, psup, etaM, pSpring, gasType, h2s_ppm}` | `{ps_set, stalls, scf_stroke, scf_d, scf_h, regDefault_scf_h (natural gas only), exhaustH2S_ppm, exhaustH2S_lb_d, verdicts}` |
| `.compat(lines)` | active lines | verdict list |
| `.stats()` | – | `{isenthalpicSolves, memoHits}` (from `WTS_gaspvt_isenthalpic.stats()`) |
| `WTS_cheminj_compute(input)` | `{stream, spread, basis, lines:[…6], cal, batch}` | `{ok, spread, hydrate, h2s, lines:[{n, point, chem, rate, pump, pressure, field, supply, options, verdicts}], summary, compat, warnings}`; accepts a precomputed `spread` for loop tests |

**Unit boundaries:** cheminj holds H2S in ppm and converts to mol % once (`_ppmToMolPct`) before any gaspvt call; `_inhKey()` maps chemlib keys to 25-hydrate keys and refuses `etoh`.

**Page calc:** `window.calcChemInj = function () { return _canon(_calcImpl); }` (units-layer canonical wrapper; always called as `window.calcChemInj()`). `render(body)`:
1. paints `#cj_root`;
2. tags inputs;
3. attaches listeners on `#cj_root` only (`input`/`change` → `window.calcChemInj()`);
4. ends with `window.calcChemInj()`.

Recalculate on `document` `wts:unit-system-changed` and `wts:base-conditions-changed` when `#cj_res[data-done="1"]` (V_m changes the lb of H2S and the methanol vapour constant).

**State:** `WTS_state.cheminj = {ok, ts, lines:[{n, point, chem, gal_d, L_hr, mL_min, pump, setting, spm, pReq_psig, pRating_psig, verdict}], total_gal_d, hydrate:{controlNode, dT, XR, inh_gal_d, fJT}, h2s:{removed_lb_d, contact_s}, result}`.

### 6.4 Engines reused (do not duplicate)

| Engine | File | Used for |
|---|---|---|
| `WTS_hydrate_temp`, `WTS_hammerschmidt_depression`, `WTS_hammerschmidt_invert` | `prism-build/25-hydrate.js` | T_hyd, Hammerschmidt path (key map; 80 wt % clamp treated as out of range) |
| `WTS_h2s_scavenger`, `WTS_h2s_so2` (and a link to `WTS_h2s_roe` on the H2S page) | `prism-build/44-calc-h2sroe.js` | Gas mass balance, flare SO2 before/after |
| `WTS_gaspvt_pseudoCriticals`, new `WTS_gaspvt_z`, `WTS_gaspvt_enthalpy`, `WTS_gaspvt_isenthalpic` | `prism-build/46-calc-gaspvt.js` | Z, Bg, velocity, contact time, choke T |
| `WTS_gradient_compute` | `prism-build/48-calc-wellkill.js` | Shut-in gas column at depth; liquid-column siphon cross-check |
| `WTS_flowline_friction.colebrook` (Phase 2: `WTS_flowline_march` reverse for P at depth) | `prism-build/49-calc-flowline.js` | Turbulent capillary friction; tubing P (chain as in `49-calc-gaslift.js` L168-220) |
| `WTS_tubulars` (`capacity(id)`, tubing list) | `prism-build/40-calc-tubulars.js` | Tubing ID, downhole velocity and pill volume |
| `WTS_state.flow` (v 1) | host `calcWTS` (L100599-100613) | Simulator import (Phase 2) |
| `WTS_state.lineheat` | `prism-build/49-calc-lineheat.js` | Heater-inlet arrival T import (Phase 2) |
| `WTS_state.h2sroe`, then `wts_page_h2sroe` | `prism-build/44-calc-h2sroe.js`, host autosave | H2S import (Phase 2) |
| `WTS_baseConditions`, `WTS_units` (`tagInput`, `runCanonical`, `format`), `WTS_fmtNum` | `prism-build/22-units.js`, host | Units, base conditions, formatting |
| `drawLineChart` (host L1997-2070, host lexical scope; guard `typeof drawLineChart === 'function'`) | host | Both charts: polylines in data order, dash patterns, legend; markers as single-point datasets and vertical lines as 2-point datasets (gaspvt L470-474 pattern) |

### 6.5 Units

- **Tag inputs** with `WTS_units.tagInput` (categories in §2.3). ΔP fields (`cj_dh_civ`, `cj_dpq_n`, `cj_pmabs`) use `pressure`, never `pressureG`.
- **Reuse existing categories:** `sandLoading` for lb/MMscf (numerically identical to mg/Sm³), `volPerMass` for gal/lb (as h2sroe does), `volumeSmall` for `cj_b_tree` and tank volumes, `massRate` only for lb/h.
- **Add only these, in-file, with the add-if-absent pattern** (49-calc-lineheat.js L70-84):

| New key | Imperial | Metric | Factor (imperial → metric) |
|---|---|---|---|
| `chemRate` | gal/d | L/d | 3.785411784 |
| `chemRateHr` | gal/h | L/h | 3.785411784 |
| `doseGasVol` | gal/MMscf | L/10⁶ Sm³ | 133.681 |
| `volPerStroke` | in³ | mL | 16.387064 |
| `massRateDay` | lb/d (never mixed with `massRate` lb/h) | kg/d | 0.45359237 |
| `pressureGradient` | psi/ft | kPa/m | 22.6206 |
| `lbPerBbl` | lb/bbl | kg/m³ | 2.85301 |

- Pints are always labelled "US pt" (473.176 mL). SPM, ppm, %, s, mL and mL/min stay neutral; pump rates always show mL/min + L/h + gal/d together.
- **Result text, table headers, the summary chip and caution temperatures** use `_pair()` (h2sroe L81 pattern), so Metric mode shows converted values first. When Metric is active, the gas-dose bases preset to `l_1e6sm3` and `l_kg_h2s`.
- Validation messages are in the display system (gaspvt `MSG` pattern).

### 6.6 Autosave, project files, reports, Quick Report, help

- **Autosave:** every id'd control autosaves to `wts_page_cheminj` and travels per well in project files (`_isWellKey`). Restore runs through `hooks.silent` + `hooks.after` (§6.9).
- **Report capture rules that shape the markup** (`collectPageReport`, host L2620-2680):
  - hidden elements are skipped (`_isShown`, L2441), so lines beyond `cj_nlines` and advanced fields never reach a report; the Design basis box echoes the hidden values;
  - `.rp-skip` is honoured (L2633): the summary chip, the jump bar and the Hydrate-page banner use it;
  - `_blockTitleEl` (L2477) takes the whole `.card-title` text, so the card title holds only "Injection line n";
  - a leaf `div` longer than 600 characters, or one that contains `div div`, is dropped (L2660-2664); Notes are therefore six flat boxes of ≤ 600 characters, titled with a `NOTE_HEAD` word (L2631: notes, recommendations, assessment, …);
  - verdicts are captured only below 300 characters (L2666, strict "<"): every verdict string stays under 299 characters;
  - a visible checkbox outside `.fg-item` becomes a loose control; every toggle sits in an `.fg-item` with a label.
- **PDF, PNG and the Quick Report per-page snapshot** (`wts_report_snapshots.cheminj`) then work with no extra code. Only computed numbers and fixed strings go into `innerHTML`; anything read from storage or imported is escaped with an `__calcEsc`-style helper.
- **Quick Report templates (host `RT_BUILTIN`, L3300-3313):**
  - final template, "Safety checks": append `'cheminj'` at the **end** of the pages list. `platform-reports.test.js` L103 asserts the "Not captured yet" order ("ESD Hi-Pilot, ESD Lo-Pilot, Hydrate Management"), which an insertion before `hydrate` would break;
  - daily template (MVP): `{ type:'pages', heading:'Chemical injection', pages:['cheminj'], detail:'results' }`.
- **Help tooltips:** the existing `hydrateSubcooling` (28-help-tooltips.js L441, "> 7 °F = inhibited / safe") contradicts the 10 °F margin, and `inhibitorPurity` is a 0.80–1.00 fraction while `cj_lean_n` is wt %. 3.2a ships without tooltips. 3.2b adds new entries `chemDesignMargin`, `chemJtFactor`, `chemLeanWt`, `chemPumpBand` to 28-help-tooltips.js (Round-6 rebuild) and puts `data-wts-help` on the `<label>` elements (tooltips attach by attribute, L1044-1062, not by id).

### 6.7 Metric mode

Imperial is canonical inside `calcChemInj`. A flip recalculates and redraws. Chart axis labels and values come from `WTS_units.format`/`_pair()`. The `gui-sweep.js` Metric pass (`S.imperial`, L365-373) scans labels, `.card-title`, `.rrow`, `.rbox-title` and table cells for gal, bbl, psi and °F; every such string is therefore built with `_pair()`, including totes ("1,041 L (275 gal)"), caution temperatures ("flash point 11 °C (52 °F)") and dose-basis labels. The PRiSM field-units note does not apply.

### 6.8 Relationship to the existing pages

| Page | MVP | Phase 2 |
|---|---|---|
| Hydrate Management (`hydrate`, 25-hydrate.js) | Its functions are reused. One-line `rp-skip` banner pointing here (Q2). Option B: hub member | Companion fixes (separate commit, Round-5 rebuild, user approval): publish `WTS_state.hydrate`; use the user margin in badges; fix the impossible default "Separator BPV" node; a "Plan injection & pump →" link that carries q_g, q_w, γ and inhibitor. Option: let it call `WTS_cheminj.hydrateDose` for its rate (changes G4 numbers) |
| H2S Exposure & Scavenger (`h2sroe`) | Unchanged; `WTS_h2s_scavenger` called with the chemistry ratio. Option B: hub member | "Plan pump →" link; "Use H2S page" import (`WTS_state.h2sroe` first) |
| Chemical & Dosage (host `chem`) | Unchanged except the one-line cross-link; the `ppmv_liq` identity test guarantees the same numbers | Option: one-click "Import product rows" (`window._chemRows` / `wts_page_chem`: product → custom chemical, ppm → `ppmv_liq`); product names escaped before `innerHTML` |

There are no saved-input migrations: new keys only, and existing routes and keys are untouched.

### 6.9 Performance and conventions

- **No timers, polling or function wrapping.** The smoke test checks pending timers after 5 s idle. No resize listener.
- **Solver cost (§4.1.2):** about 1 ms per isenthalpic solve once warm; a full calc needs at most 4 solves (flowing choke, start-up, back-pressure valve, and one per extra J-T path such as a heater alternative), and the 64-entry memo makes repeat solves about 0.02 ms. The memo is never cleared per calc.
- **Restore:** with `hooks.silent: true` the host applies all saved values without events, then `hooks.after` re-syncs `data-prev` and the show/hide state and runs **one** calc. Without it, about 30 restored fields would fire about 60 full calcs on every page open, in the a11y route sweep and in the GUI sweep.
- **Heater alternative (Phase 2):** one inverse root-find per outer step, not a bisection wrapped around the forward solver.
- **Tests use counters, not wall-clock time:** `WTS_cheminj.stats()` / `WTS_gaspvt_isenthalpic.stats()`. `perf-budget.js` measures startup only.
- **The point × chemical × pump loop** (9 × 30 × 8 = 2,160 cases) runs on `WTS_cheminj_compute` with one precomputed spread, not through the DOM (the accept-test timeout is 120 s, accept-test.js L136).
- **File size:** about 120–180 KB for the two new files and the 46 additions (48-calc-wellkill.js alone is 55 KB). The HTML is already 6.03 MB against a 4.90 MB recorded baseline, so perf-baseline.json is re-recorded in its own commit before 3.2a (§9.1).
- **Self-tests** (stripped by concat) cover only the file's own pure functions, and any cross-engine call is guarded with `typeof`.
- Loading must not fail when `document`, `WTS_units` or `drawLineChart` are missing.

---
## 7. Validation and tests

### 7.1 Numeric acceptance tests — `prism-build/tests/calc-cheminj.test.js` (WP `CHEM`)

Pure-engine tests call `window.WTS_cheminj.*`, `WTS_cheminj_compute` and the new gaspvt exports. The page tests drive the real page (nav → set → read `.rrow`), as `calc-new4` and `calc-lineheat` do. Tolerances are absolute unless "%". The increment that ships each test is in the last column.

| # | Test | Inputs | Expected | Inc. |
|---|---|---|---|---|
| N1 | Water vapour pressure | 60 / 100 / 212 °F | 0.2564 / 0.9505 / 14.71 psia (±0.0005, ±0.0005, ±0.01) | a |
| N2 | Bukacek | 1000 psia/100 °F; 1000/60; 3014.7/110; 1014.7/34.56 | 60.40 / 17.92 / 39.18 / 7.44 lb/MMscf (±0.05) | a |
| N3 | T_hyd identity; ppm → mol % boundary | 1014.7 psia, γ 0.65; H1 with H2S 20,000 ppm | 63.13 °F = `WTS_hydrate_temp` (±0.01); `WTS_gaspvt_z` receives h2s 2.0 mol % and returns `ok:true` (not the `ok:false` that 20,000 would give) | a |
| N4 | Hammerschmidt identity and key map | MeOH 25 wt %; ΔT 31.73 for `meoh` and `etoh` | 24.32 °F = `WTS_hammerschmidt_depression(25,'methanol')` (±0.01); `meoh` → 30.31 wt % via the map; `etoh` → 38.50 wt % (local M 46.07), not the methanol 30.31 | a |
| N5 | Nielsen–Bucklin and the design rule | x_I 0.13; MeOH 28.85 / 46.53 wt %; MeOH 20 / 25 wt % | 18.05 °F; W MeOH 21.00, MEG 33.99 wt %; 26.62 / 51.62 °F (±0.02); at 20/25 wt % Hammerschmidt 18.24/24.32 vs NB 17.05/22.26 °F, and `requiredWt` returns the NB (larger) concentration with no step near 25 wt % | a |
| N6 | Methanol K-value | 1000 psia, 10 °F, 25 wt % | K 9.614×10⁻⁴ (±1 %); 12.81 lb/MMscf (±1 %) with V_m 379.48 | a |
| V1 | J-T validation, methane | DAK with Sutton at γ 0.5539, real-gas Cp; 250 and 300 K at 0.1, 2.1, 5.1, 10.1 MPa | NIST/DAK μJT ratio within 0.95–1.10 at all 8 points (computed 0.999–1.089); default f_JT ≥ the largest ratio | a |
| V2 | J-T validation, Katz chart | γ 0.6 from 2000 psia; T₁ 100 / 120 °F; T_hyd Towler–Mokhatab | lowest permissible P₂ at design: 1130 ±150 psia (chart ≈ 1100, to be confirmed from the GPSA figure before release) and 510 ±150 psia (DAK alone: unlimited) | a |
| N7 | Isenthalpic solver (raw DAK, then design × 1.10) | γ 0.65: 110 °F 3014.7→1014.7; 100 °F 2000→500; 80 °F 1000→100; 60 °F 3514.7→1014.7; 90 °F 1014.7→264.7 | DAK 41.42 / 25.26 / 24.24 / −18.81 / 47.51 °F (±0.3; self-consistency with the prototype, accuracy is V1–V2); design 34.56 / 17.78 / 18.67 / −26.69 / 43.27 (±0.3); ≤ 6 Newton iterations each | a |
| N8 | Rule option | 110 °F, 2000 psi drop | −30.0 °F, quick-check label present | a |
| N9 | H1 hydrate (choke T fixed at 34.56 via `user`) | §4.13 inputs | ΔT 38.57 (±0.05); X_R 38.14 (±0.05, NB; Hammerschmidt 34.58 shown); condensed 317.4 (±1); free 735.4 (±0.5); aqueous 649.0 (±2); vapour 412.5 (±3); total 1061.5 lb/d (±5); 159.95 gal/d (±0.8); 420.5 mL/min (±2) | a |
| N10 | H1 end-to-end (isenthalpic × 1.10) | page defaults | T₂ 34.56 ±0.3; total 1061.5 lb/d ±3 %; node table: choke outlet at risk, flowhead no risk; table title states "margin 10 °F, J-T × 1.10" | a |
| N11 | H1 variants | method `ham` (reference); `cond=all`; lean 95; q_o 20 | 923.6 ±6 lb/d; 1107.3 ±5; 1154.8 ±5 lb/d (172.2 ±1 gal/d) with the rigorous balance; +6.6 ±0.3 lb/d (f_c 0.331) | a |
| N12 | MEG 80 wt % | H1, MEG, auto, loss 0 | X_R 54.42 (±0.05); 2240 ±10 lb/d; 246.4 ±1.5 gal/d | a |
| N13 | Practical limits | start-up 60 °F tree, SITHP 3500; DEG with ΔT 160 °F | T₂ −26.69 ±0.5 °F; X_R 67.36 ±1.0 wt % → ⚠ marginal; ΔT forcing > 70 wt % → ✗ and no rate; DEG returns ✗ and no rate (never the clamped 80 wt %) | a |
| N14 | Shut-in | SITHP 3500, margin 10; T_amb 60 and 50 | 60 °F: ΔT 30.76 ±0.05; MeOH 32.27 ±0.1; MEG 47.99 ±0.1 (Hammerschmidt 41.39 shown). 50 °F: ΔT 40.76; MeOH 39.66; MEG 56.01 ±0.1 (Hammerschmidt 48.34 shown) | a |
| N15 | Second expansion | H1 + heater 90 °F + `cj_pbpv` 250 | T 43.27 ±0.5 °F; T_hyd 44.06 ±0.1; ✗ inside the hydrate region; condensed 164.1 ±5 lb/d; `sepgas` dose 370.8 ±10 lb/d, vapour share ≥ 90 % | b |
| N16 | LDHI | 100 bwpd, KHI 1.5 %; H1 KHI; H1 KHI with T_amb 50; H1 AA | 63.0 gal/d; 1.83 ±0.05 gal/d with max subcooling 89.8 ±1 °F (start-up) → ✗ naming the start-up case; shut-in alone 30.8 °F → ✗; AA ✗ no liquid HC | b |
| N17 | Sour hydrate | H1 + H2S 20,000 ppm; H1 + 50,000 ppm; the same with a user T_hyd 80 °F at 1000 psig | margin used 20 °F (10 + 10) with sour ⚠; ✗ correlation refused, no rate; user T_hyd → rate given, no ✗ | a |
| N18 | ppm identities | §4.9 table | 5.25; 3.78 (9.94 mL/min); 0.735; 0.630 (+ turndown ⚠ with `elec_solenoid`); 16.8; 25.2; 2.50; bisulfite 0.163 gal/d (SG_w/SG_c applied); 5.04 gal/d = 13.2489 cc/min = host `chem` formula (±1e-4) | a |
| N19 | Scavenger ratio | MEA-triazine 40 %, SG 1.11, η 0.58 | R_th 0.8691 (±0.0005); R 1.4984 (±0.001) | b |
| N20 | S1 identity | 5 MMscf/d, 50→4 ppm, CE 98 % | removed 20.656 (±0.005) = `WTS_h2s_scavenger`; 30.95 gal/d (±0.05); 81.4 mL/min (±0.2); SO2 avoided 38.05 (±0.05) = 24 × (`WTS_h2s_so2(5,50,98)` − `WTS_h2s_so2(5,4,98)`) | b |
| N21 | Base conditions | switch Std to 15 °C / 101.325 kPa | removed lb/d changes exactly as `WTS_h2s_scavenger`; methanol vapour constant follows V_m; page recalculates on `wts:base-conditions-changed` | b |
| N22 | Contact time | S1 segments, Z from `WTS_gaspvt_z` | Z 0.871 / 0.945 / 0.958 / 0.959 (±0.005); t 1.15 / 1.88 / 3.24 / 2.18 s (±0.03); total 8.45 (±0.05); ⚠ < 15 s; no erosional ⚠ (max 62 % of v_e) | b |
| N23 | Liquid H2S; partial pressure; targets | 2000 bopd SG 0.85, 50 ppmw; 500 ppm at 1500 psia; 10 lb/h, 5 MMscf/d, CE 98 %; 5 mg/m³ at 15 °C and 0 °C bases | 29.77 lb/d; 0.750 psia ⚠; 290 ppm (±1); 3.47 / 3.29 ppm (±0.01) | b |
| N24 | Plunger geometry | 3/8 × 1 in | 0.110447 in³; 1.8099 mL; 0.68850 gal/d per SPM | a |
| N25 | SPM | 30 gal/d, 3/8 × 1, ηv 0.9; 1/2 in | 48.41 SPM (1.239 s/stroke, 12.10 per 15 s); 27.23 SPM (±0.01) | a |
| N26 | Calibration | 72 mL / 60 s at 48 SPM, target 30 gal/d | 27.39 gal/d; ηv 0.8288; 52.58 SPM (±0.01) | a |
| N27 | Metering setting | 2 L/h on 10 L/h; 7 L/h; 0.3 L/h | S 40/N 50 (pulse 60, 0.556 mL); S 100/N 70; S 20/N 15 + ⚠ turndown (f 0.03 < max(0.10, 0.02)); calibration 36.0 mL/min at 50/40 → N 37.04 % | a |
| N28 | H1 pump options | 159.95 gal/d, P_req 3550, rating 3905, classified area | pneumatic (4/6/8 in, simplex/duplex): none feasible, reasons name 4 in 1/2 in (rate 242 %), 4 in 3/4 in (pressure 2,276), 8 in 1 in (peak 121 %), 8 in 1 in duplex (pressure 2,560); air-driven ranked first: flow at 3550 psig 464.4 ±1 gal/d, air 45.6 ±0.2 psig (peak 63.9), 25.7 cycles/min; electric plunger 7/8 in × 1 head at 39.5 ±0.1 % (peak 79.0), P_max 4,158, swept 3.89 / delivered 3.50 mL, with the certified-motor ⚠ | a |
| N29 | S1 pump options | 30.95 gal/d, rating 1705 | pneumatic 1/2 × 1 in at 28.10 SPM (46.8 %), peak 42.1; 3/8 in infeasible at peak | b |
| N30 | Next plunger | 30 gal/d on 1/4 × 1 pneumatic | 108.9 SPM ✗ → suggests 3/8 in (48.4 SPM) | a |
| N31 | Pressure ratings | H1 `wh`; H1 `dsch`; H1 `wh` with `cj_mawp_1` 3000; H1 `wh` with rating basis `class` (5000) | P_req 3550, P_back 3500, rating 3905, PSV lo 3905; P_req 1050, P_back 1440, rating 1584, PSV lo 1440; ✗ "below the shut-in wellhead pressure"; rating 5500 | a |
| N32 | Downhole D1 | §4.13 D1 | SG 0.7645, μ 0.397; hydrostatic 2651.4 (±1); friction 36.0 (±0.5), Re 834 (±5); P at depth 4242.2 (±5); flowing 1684.6 (±1); shut-in 3126.8 (±5); rating 3850 (±1); PSV lo 3500; siphon need 1260.7 (±1): CIV 1500 ✓, CIV 1000 ✗ free-fall; `cj_dh_ggrad` 0.08 → P at depth 4140 | b |
| N33 | Capillary friction | MEG 80 wt % 15 cP / methanol 0.6 cP, 10,000 ft, 1/4 × 0.049, 30 gal/d; Re ≥ 2000 case; MEG with tank 35 °F | 1598 ±16 psi / 63.9 ±0.5 psi (μ forced); laminar; the Colebrook branch above Re 2000; glycol-cold ⚠ | b |
| N34 | Tank and totes | 275 gal, heel 10 %, 30 gal/d; 4 ft tank; H1 5 d | 8.25 d; 3.83 in/d; 1.55 d ⚠, 960 gal, 4 totes on site, 3 tote changes | a |
| N35 | Drive gas | S1, 4 in actuator, 1/2 × 1 in, 28.10 SPM, P_d,design 1550 | P_s,set 35.3 (±0.1); 0.02472 scf/stroke; 1000 ±5 scf/d; 13.3 scf/h default shown for gas drive only; `well` + 50 ppm → ✗ with exhaust 50 ppm; `air` → no GHG line, no ✗; `cj_psup` 30 → ✗ stall | a |
| N36 | Batch | fill to choke + 10 gal; to heater inlet; 2.441 in to 3000 ft | 16.86 gal; 52.70 gal; 17.36 bbl | b |
| N37 | Compatibility | nitrite + MEA-triazine, same tank; methanol + phosphonate SI at `wh`; peroxide in a hydrocarbon tank | ✗ oxidiser verdict; ⚠ methanol / scale-inhibitor verdict; ⚠ O2 evolution verdict | b |
| N38 | Suitability | MEA-triazine at `dh`; nitrite at `wh`; antifoam at `sepgas`; nitrite at `tank` | ⚠ N; ✗ X; ✗ X; ⚠ N oxidiser (rate still finite, flagged) | b |
| N39 | Water from aqueous chemicals | H1 + MEA-triazine line (30.95 gal/d, SG 1.11, 60 % water) at `wh`; same with no THI line | other water 171.8 (±0.5); m_W 1224.7 (±1); total 1167.4 (±5); without a THI line: ⚠ "can form hydrate or ice" | b |
| N40 | Backflow and thermal relief | H1 line 1 | line row 77 ±1 psi/°F; Summary carries the backflow ⚠ and the thermal-relief ⚠ | a |
| N41 | Heater alternative (Phase 2) | H1 | 142.1 ±1.5 °F (DAK alone 136.9) | P2 |
| N42 | Engine boundaries | γ 1.05; `WTS_hammerschmidt_invert` spy | cheminj raises the γ ⚠ itself; the 25-hydrate engines are never called with `meoh`/`etoh` | a |
| N43 | Scavenger guards | y_in 0; y_out ≥ y_in; q_g 0; η 0.05 for MEA-triazine | ✓ rate 0; ✓ rate 0; ✗ needs gas rate; η clamped to 0.087 with ⚠; no engine error text for these | b |
| N44 | Solver cost by counter | page open with saved values; a second calc with no change | ≤ 4 isenthalpic solves and exactly one calc on restore; 0 new solves on the repeat (memo) | a |

### 7.2 Edge cases (each must render without NaN / Infinity / undefined / null / [object Object])

| Case | Expected behaviour |
|---|---|
| Zero free water, dry gas | Dose from condensed water only (H1 with q_w 0: m_W 317.4 lb/d) |
| Zero water and W_in ≤ W_out | ✓ "No free or condensed water at the controlling node: no thermodynamic inhibitor needed", rate 0, pump block shows "no flow required" |
| No hydrate risk (every node T ≥ T_hyd + margin) | ✓ "No hydrate risk at the spread nodes with a 10 °F margin"; THI line rate 0 with ⚠ "line not required" |
| No H2S with a scavenger line | ✓ "No H2S: no scavenger needed"; rate 0; H2S block hidden unless a scavenger line exists |
| Target ≥ inlet | ✓ "Inlet is already at or below the target" |
| q_g = 0 | Gas-basis lines ✗ "needs gas rate"; liquid lines still work |
| H2S 100,000 ppm | Correlation refused (✗) unless user T_hyd; gaspvt receives 10 mol % |
| Pump cannot reach pressure | ✗ "Pump cannot reach X psig with this plunger (max Y): choose ≤ d in, a larger actuator, an air-driven pump or an electric plunger pump" |
| SPM above 85 % / below the stable minimum | ⚠ / ✗ with the next larger / smaller plunger and its SPM |
| Metering turndown | ⚠ when f < max(0.10, S_min·N_min): "dilute 1 : n or a smaller head" (n = ceil(0.25·Q_max/Q)) |
| Air-driven pump below 0.1·Q₀ or above 0.7·P_stall | ⚠ erratic cycling / ✗ near stall |
| Drive gas too low at shut-in | ✗ stall verdict, setting shown |
| Siphon failure; MEG viscosity at a cold tank | ✗ CIV message; ⚠ glycol-cold friction |
| T₂ below −40 °F; P_pr > 15 | ⚠ correlation range; T₂ clamped to the solver floor with a warning; `WTS_gaspvt_z` still returns Z |
| Correlation ranges (γ outside 0.55–1.0 for T_hyd, MeOH loss outside −10 to 100 °F / 100–5000 psia) | ⚠ with the range text; values still computed |
| Blank / 0 / −1 / 1e12 in every numeric input | `.val-error` on the field and an error list, no throw (pattern from `calc-v31-sweep.test.js`) |
| Every point × chemical × pump option combination | Finite output from `WTS_cheminj_compute` with one precomputed spread (2,160 cases), no console errors |
| `cj_nlines` 6, every line on, then back to 1 | Lines 2–6 hidden as whole cards; none in the report |

### 7.3 UI and integration tests

1. Registry entry well-formed; group Test System Safety; title/sub; icon; `hooks.silent`; `WTS_cheminj_compute`, `WTS_cheminj` and `WTS_chemlib` exist (smoke).
2. Sidebar: Option A — Test System Safety has 8 rows, `cheminj` sits next to `hydrate`/`h2sroe`; Option B — the hub shows Chemical Injection | Hydrate Management | H2S Exposure & Scavenger and HUBS is updated. `calc-new4` L82-88 still passes (h2sroe stays in the group); `ux-layout-check.js` fit at 1280 × 800.
3. Default render shows H1 results, the chip "Methanol · Upstream of choke · 160.0 gal/d · air 45.6 psig", both canvases drawn (recording context), the Design basis box and six Notes boxes.
4. A chemical change presets the chemical-property fields once and never changes `cj_pt_n`. In Metric mode, changing the chemical makes the tank field show 1041 L, not 275. A reload with saved values keeps the user values. Project save/open round-trip.
5. Metric: `setSystem('metric')` converts tagged inputs, shows SI first, recalculates; flip back restores the same numbers (±1e-6 relative). A text scan of labels, card titles, `.rrow`, `.rbox-title` and table cells finds no imperial-only unit in Metric.
6. Report: `collectPageReport(#pgBody).results` contains all six Notes boxes, the top-line ⚠ disclaimer, the Design basis box, the node table, the line result rows and verdicts. Lines beyond `cj_nlines` are absent; the chip text is in no section title; there is no "Line n in use: No" control. `wts_report_snapshots.cheminj` exists; PDF export does not throw.
7. Restore: with `hooks.silent`, one calc runs (counter) and the show/hide state is right (a saved `air_liquid` line shows Q₀/ratio/displacement; a saved downhole line shows the downhole fields).
8. a11y: every control, toggles included, has a label or `aria-label` (a11y.test.js L60-84 route sweep passes).
9. Hydrate page banner (Q2) present and not in its report (`rp-skip`); `chem` page cross-link present.
10. Quick Report: final template ends its Safety checks with `cheminj` and `platform-reports.test.js` L103 passes unchanged; the daily template has the "Chemical injection" section.
11. Imports (Phase 2): with `WTS_state.flow` (v 1) and `WTS_state.h2sroe` fixtures, the buttons fill P/T/H2S canonically and recalculate.
12. No pending timers after 5 s (smoke).

### 7.4 Gates (per increment)

- `node --check prism-build/.tmp/wts-main.js`.
- `node prism-build/smoke-test.js`: 311 + about 4 new checks.
- `node prism-build/accept-test.js --html --integration` and `--sources`: 853 + about 40 new in 3.2a and about 25 more in 3.2b.
- `node prism-build/gui-sweep.js --route cheminj,hydrate,h2sroe,chem --quick`, then `--route cheminj --mobile` (Metric and decimal-comma passes run automatically). Expect 0 error-level findings and no Metric imperial-label findings.
- `node prism-build/ux-layout-check.js` (1280 × 800 sidebar fit); `ios-webkit-check.js` when available.
- `node prism-build/perf-budget.js` against the baseline re-recorded before 3.2a (§9.1).
- Integration: `concat-round9.js` + `inject-round9.js` (and Round 5 for the Hydrate banner), CRLF re-normalise (Windows copy), `ios-app/scripts/sync-from-main.js`.
- **Version bump** (tests/ios-native.test.js L83-101 enforces it): `RELEASE_NOTES[0].ver` (3.2 for 3.2a, 3.2.1 for 3.2b — each App Store upload needs a higher version, ITMS-90062), `MARKETING_VERSION` in `project.pbxproj`, and `VERSION_BASE` in both `ios-app/ci_scripts/ci_post_clone.sh` and `ios-app/ios/App/ci_scripts/ci_post_clone.sh` (currently "3.1.1").
- Update CLAUDE.md (file map: `40-calc-chemlib`, `49-calc-cheminj`; 20th plug-in calculator; test counts; shared engines `WTS_gaspvt_z`, `WTS_gaspvt_isenthalpic`, `WTS_cheminj`), README and the `RELEASE_NOTES` item.

---

## 8. Safety, disclaimers, assumptions and limitations

### 8.1 Text shown in the app

**Top line (always, verdict div, 165 characters):** "⚠ Planning estimate. Confirm doses with the chemical data sheet, compatibility and bottle/loop tests, and calibrate every pump at line pressure before relying on it."

**Notes boxes.** Six flat `<div><b>Notes</b> …</div>` boxes, each ≤ 600 characters including the title (the host drops longer ones). The J-T factor in box 1 is filled from the input. Character counts are in brackets; a UI test asserts every box is captured.

1. **Notes** (541) "Methods. Hydrate temperature: gas-gravity correlation (Towler–Mokhatab 2005), sweet gas, about ±5 °F. Choke temperature: real-gas isenthalpic (DAK) with J-T cooling × 1.10 for design. Depression: larger of Hammerschmidt and Nielsen–Bucklin (Hammerschmidt only for DEG/TEG). Water: free + condensed (Bukacek) + water in other aqueous chemicals. Methanol loss to gas: K-value correlation. Scavenger: stoichiometry ÷ utilisation. Pumps: displacement × volumetric efficiency. Downhole: tubing pressure + valve set + friction − hydrostatic."
2. **Notes** (356) "Sour service and samples. The sour-service materials basis and the radius of exposure use the untreated H2S; scavenging does not change them. Take PVT and H2S samples upstream of the scavenger, or with it off. Do not drive pneumatic or air-driven pumps with sour produced gas: use instrument air, nitrogen or sweet gas, or route the exhaust to flare."
3. **Notes** (529) "Injection hardware and overpressure. Every tie-in: block valve, two check valves in series and a bleed, rated to the flowhead or manifold class and leak-tested before opening the well; a tie-in upstream of the surface safety valve can bypass it. Rate the pump discharge for the shut-in or tie-in pressure, not the operating pressure. Fit a relief valve on every pump discharge and drive-gas regulator. Size the tank vent for gas blow-by or fit a low-discharge-pressure trip: the pump relief valve does not protect the tank."
4. **Notes** (465) "Methanol. Flash point 52 °F (11 °C), near-invisible flame, toxic by skin, inhalation and ingestion (exposure limit 200 ppm, skin). Bond and ground during transfer; flame arrestor on the vent; bund at 110 %; shade the tank and keep a flooded suction. Separator water carrying methanol is itself flammable: treat water tanks, pits and lines as hazardous. With high-salinity brine, methanol can precipitate salt and scale. Area classification per API RP 500/505."
5. **Notes** (542) "Plugs, mixing and shutdown. Treat a suspected hydrate plug as trapped pressure: depressurise both sides equally and never heat the middle of a plug. Never mix incompatible chemicals in one line or tank, and flush lines when changing chemical. Oxidisers (peroxide, nitrite) go only into a vented, non-hydrocarbon tank and are never blocked in. Fit thermal relief on blockable liquid-full sections, or lock them open. Decide the ESD philosophy for each chemical pump (trip, or keep running for shut-in hydrate protection) before the test."
6. **Notes** (376) "Data limits and sign-off. LDHI, scavenger utilisation, treating-chemical doses and pump presets depend on the formulation and the equipment; values here are screening ranges and illustrative envelopes, to be replaced by data-sheet and nameplate values. This page is not a substitute for the operator's chemical programme, permit to work or a competent engineer's review."

### 8.2 Verdict strings (plain text, each under 299 characters; longest with typical values about 205)

Hydrate and spread
- ✓ "No hydrate risk at the spread nodes with a {m} °F margin."
- ✗ "Hydrate risk at {node}: {T} °F is {s} °F below the hydrate temperature {Th} °F (margin {m} °F). Inject upstream of {node}."
- ⚠ "Choke outlet uses 7 °F/100 psi: a quick check that can overstate or understate cooling."
- ⚠ "J-T factor {f} is below 1.10: DAK alone under-predicts J-T cooling by up to 9 %."
- ⚠ "Required {X} wt % {inhibitor} is high: chemical-only inhibition is marginal. Consider heating, staging the choke or a smaller start-up choke."
- ✗ "Required concentration is beyond the method range ({X} wt %): no rate given. Heat or stage the pressure drop."
- ⚠ "Sweet-gas hydrate correlation used on sour gas: margin raised by {a} °F (margin now {m} °F). Enter a lab or composition-based hydrate temperature."
- ✗ "H2S {y} mol % is beyond the sweet-gas correlation: enter a lab or composition-based hydrate temperature. No rate given."
- ⚠/✗ "Gas re-expands at the back-pressure valve to {T} °F against a hydrate temperature of {Th} °F (margin {m} °F): add an injection point at the separator gas outlet, heat-trace, or lower the back-pressure."
- ⚠ "{chemical} is about {w} % water and is injected upstream of a hydrate-risk node ({node}) with no hydrate inhibitor: it can form hydrate or ice there."
- ✗ "KHI not viable: largest subcooling {s} °F ({case}) exceeds 27 °F. Use a thermodynamic inhibitor."

H2S
- ⚠ "Scavenger contact to the separator is {t} s, below {req} s: expect lower utilisation. Check H2S at the gas outlet with stain tubes and trim the pump."
- ⚠ "Aqueous scavenger in the separator gas outlet needs a knock-out or contactor downstream; otherwise liquid carries to the flare."
- ⚠ "Oxidiser: O2 or NOx evolution into a hydrocarbon vapour space; dose only into a vented, non-hydrocarbon tank."
- ⚠ "Never block in an oxidiser line: gas evolution overpressures it; fit vented relief."

Pumps and pressure
- ✗ "Pump cannot reach {P} psig with a {d} in plunger (maximum {Pmax} psig). Use a smaller plunger, a larger actuator, an air-driven pump or an electric plunger metering pump."
- ⚠ "{spm} SPM is {pct} % of the {max} SPM maximum, leaving no start-up headroom. Next plunger: {d2} in at {spm2} SPM."
- ⚠ "Air-driven pump: set the air and verify the rate with a drawdown cylinder or meter. Stall at this setting is {Ps} psig; the discharge relief valve is the overpressure protection."
- ⚠ "Electric pump in a classified area: motor and controls must be certified for the zone (API RP 500/505)."
- ✗ "Do not drive pneumatic pumps with sour produced gas: use instrument air, nitrogen or sweet gas, or route the exhaust to flare. Exhaust carries {y} ppm H2S ({m} lb/d)."
- ✗ "Drive gas {P} psig is too low to inject at the shut-in pressure: the pump stalls before the well is opened."
- ✗ "Discharge circuit rated {MAWP} psig, below the shut-in wellhead pressure {SITHP} psig."
- ✗ "Relief valve band is empty: the set pressure must be at least {lo} psig but the circuit MAWP is {hi} psig."
- ⚠ "Backflow: block valve, two check valves in series and a bleed at the tie-in. Size the tank vent for gas blow-by or fit a low-discharge-pressure trip; the pump PSV does not protect the tank."
- ⚠ "Thermal relief on any blockable liquid-full section, or a lock-open procedure: blocked-in {chemical} rises about {r} psi per °F."
- ✗ "Capillary column free-falls: set the injection valve to at least {P} psi."

Supply and field
- ⚠ "Tank lasts {d} days at this rate against a {D}-day test: plan {n} tote changes or a larger tank."
- ⚠ "Calibration reads {pct} % from target: reset to {set} and re-test."
- ✗ "{chemical} and {chemical} must never share a line or tank: {reason}."

### 8.3 Assumptions and limitations

- Sweet-gas, gas-gravity hydrate curve (no composition model). Sour gas gets a scaled margin adder up to 3 mol % H2S and is refused above that (Baillie–Wichert not digitised).
- J-T cooling: DAK departure functions with a 1.10 design factor, validated against methane (NIST) and the Katz chart only; no reference yet for γ > 0.7 [M].
- Thermodynamic depression constants are pressure-independent. Hammerschmidt and Nielsen–Bucklin only (Moshfeghian–Maddox and Østergaard constants were not obtained). MEG depression data scatter by 3–8 wt %.
- Bukacek is lean sweet gas and extrapolated below 60 °F. Salt depression is ignored (conservative).
- Methanol loss to condensate scales with the aqueous mole fraction from one reference value. Ethanol loss uses the methanol correlation. Glycol losses are a percentage.
- Water fractions of products are typical values; enter the data-sheet value.
- Isenthalpic choke for gas only (MVP). No retrograde condensation or liquid heat capacity. DAK is unreliable near inversion above ~5000–6000 psia when cold.
- Heater and line heat loss are not modelled in the MVP: user T (Phase 2 import from lineheat).
- Scavenger utilisation is a user input with point defaults. No kinetic or contact-time correlation exists in the open literature.
- LDHI and treating-chemical doses are generic screening ranges.
- Pump presets, including the air-driven pump curve, are illustrative generic envelopes: nameplate values and published curves must replace them.
- ηv auto model ignores gas entrainment. Drive-gas use is a first-principles estimate with an assumed spring-return offset.
- Back-pressure for points downstream of the choke defaults to the separator PSV set; relief valves are not sized.
- Downhole temperature at depth is user input. MVP viscosity and SG use the mean of the surface and depth temperatures; the siphon check uses the cold SG. Capillary rating is a Barlow screening value.
- Steady flow. Start-up and shut-in are point checks, not transients.

---
## 9. Phased delivery

### 9.1 Prerequisites (before any 3.2a code)

1. Identify and fix the failing acceptance test: HEAD `0c25ada` is v3.1.1 WIP with 852/853 passing and one failure not yet identified.
2. Merge 3.1.1 to Dev and master.
3. Re-record `prism-build/perf-baseline.json` in its own commit: `perf-budget.js` already fails today (HTML 6.03 MB against the 4.90 MB baseline + 10 %).
4. User decisions Q1 (sidebar), Q2 (Hydrate-page banner), Q5 (margin), Q17 (J-T factor), Q18 (sour limit), Q19 (default pump).
5. Read the Katz permissible-expansion values off the GPSA Engineering Data Book figure for test V2.

### 9.2 Increment 3.2a (app version 3.2) ≈ 13–15 engineer-days

Scope: spread and THI hydrate design (H1) with the validated J-T solver; ppm-basis chemicals; plunger, metering and air-driven pump settings with hazardous-area ranking; surface discharge pressure with the P_back basis, PSV band, backflow and thermal-relief verdicts; drive-gas setting and the sour-drive-gas ✗; calibration and tank; sidebar placement; report; Metric; phone layout; Hydrate-page banner; `chem` cross-link; Quick Report entries.

| Item | Effort (d) |
|---|---|
| `40-calc-chemlib.js`: chemicals (with water %, α_v, oxidiser flags), pumps (with air-driven and actuators), points, suitability matrix, compatibility, capillary, elastomer + self-test + smoke shape check | 1.5 |
| 46 additions: `WTS_gaspvt_z`, `_enthalpy`, `_isenthalpic` (Newton with Cp slope, 40-point Gauss–Legendre, 64-entry memo, `stats()`) + N7, V1, V2 | 1.5 |
| Engines: spread (flowing, shut-in, start-up), water content (incl. other chemicals), depression (key map, design rule, clamps), hydrate dose (rigorous balance), ppm bases (product/active), pump setting and options, injection pressure (surface), drive gas, calibration, tank, `WTS_cheminj_compute` | 3.5 |
| Page: cards 1–4, line cards with per-kind fields and Advanced toggles, calibration card, Design basis box, results, chip, two charts, six Notes boxes, units categories, `_pair()`, Metric, jump bar, `hooks.silent` restore | 3.5 |
| Host and Round 5: `__NAV_ORDER` (or hub), `RT_BUILTIN` final + daily, `chem` cross-link, Hydrate banner, release note and version bump | 0.75 |
| Tests (≈ 40 numeric + UI 1–10), smoke; gui-sweep `--route` and `--mobile`, fixes | 2.5 |
| Integration rebuild, iOS sync, CLAUDE.md/README, review | 0.75 |

### 9.3 Increment 3.2b (app version 3.2.1) ≈ 9–11 engineer-days

Scope: H2S scavenger with targets, guards, contact time and SO2; downhole/capillary/siphon; LDHI screening; second expansion; oxidiser rules; compatibility and elastomer lines; drive-gas consumption; batch card; help tooltips.

| Item | Effort (d) |
|---|---|
| Scavenger engine and H2S block: targets with base, guards, SO2 before/after, contact time with `WTS_gaspvt_z`, erosional check | 2.0 |
| Downhole: `WTS_gradient_compute` gas column, SG/μ at mean T and cold SG, capillary friction and Colebrook branch, siphon and cross-check, downhole fields | 2.0 |
| LDHI screening (max subcooling), second expansion and `sepgas` dose, oxidiser rules, compatibility and elastomer lines | 1.5 |
| Drive-gas consumption and GHG default; batch card (fill to segment, pill) | 1.0 |
| Help tooltip entries (Round 6) | 0.5 |
| Tests (≈ 25), gui-sweep, integration, version bump | 2.5 |

### 9.4 Phase 2 (v3.3) ≈ 8–10 engineer-days

1. Import buttons: simulator (`WTS_state.flow` v 1), Line Heat Loss, H2S page (`WTS_state.h2sroe` first) (1.0).
2. 25-hydrate.js companion fixes (state, margin badges, default BPV node, link) after user approval (1.5).
3. Automatic second-expansion line suggestion with its dose; cold-start case; hand-pump preset (1.5).
4. Heater alternative as an inverse root-find (0.5).
5. Downhole tubing pressure from `WTS_flowline_march` reverse; μ(T(z)) integration over 20 segments (1.5).
6. Drive gas → Flare & GHG link; nozzle-orifice check (0.5).
7. Option: `chem` product-row import, with product names escaped (0.5).
8. Liquid J-T correction (ΔT_mix) for oil wells (0.5).
9. Tests N41 + imports (1.0).

### 9.5 Phase 3 / v2 ≈ 12–18 engineer-days (depends on literature access)

- Moshfeghian–Maddox and/or Østergaard depression once the papers are in hand; MEG water-activity correction fitted to Hemmingsen et al. (2011).
- Bahadori methanol solubility in condensate; a digitised Baillie–Wichert sour-gas correction (would lift the 3 mol % H2S refusal).
- J-T reference for heavier gases (γ > 0.7): a composition-based cross-check, if V1–V2 coverage proves too narrow.
- Live verification: Modbus tags (stroke counter, low-flow meter, discharge PT, tank level) → `WTS_historian`; dosing-deviation alarm when |Q_live − Q_target| > 10 %; tank reconciliation.
- Scale link (`49-calc-scale.js` SI > 0 → scale-inhibitor suggestion); optional corrosion-rate-based inhibitor screening.
- Cross-project custom product library (extend `LIBRARY_RE` in 29-project-save.js) if wanted.

### 9.6 Out-of-module follow-ups (other workstreams)

- `31-wts-sim.js`: its `hydrateT` reads 2–4 °F below `WTS_hydrate_temp` (non-conservative) while its header says "calc-identical". It also uses a fixed J-T of 0.07 °F/psi. Both should call the shared engines (Round-7 workstream; separate change).
- `49-calc-lineheat.js` / `49-calc-flowline.js`: optionally adopt `WTS_gaspvt_isenthalpic` (with the design factor) instead of a fixed μJT (separate change).
- 3D simulator chemical skid showing the planned rate (Round-7).

### 9.7 Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Correlation error (T_hyd ±5 °F, MEG scatter, J-T bias) leads to under-dosing | Hydrate plug, safety | 10 °F margin, J-T × 1.10 validated by V1–V2, max(Hammerschmidt, NB), scaled sour adder with a refusal above 3 mol % H2S, user-override path, field concentration check advice |
| Discharge circuit under-rated against back-pressure | Loss of containment, well gas to the chemical tank | P_back basis, PSV never below P_back, backflow and thermal-relief verdicts, Notes box 3 |
| Users take generic doses or pump presets as design values | Wrong rate or pressure | Labels "screening / illustrative", editable fields, top-line disclaimer, calibration card, mandatory drawdown note for the air-driven pump |
| Page size (≈ 200 controls) on phones | Usability | ≈ 60 visible on open, per-kind fields, Advanced toggles, jump bar, Design basis echo, gui-sweep `--mobile` |
| Restore cost and solver cost under the sweeps | Slow page, sweep timeouts | `hooks.silent` (one calc on restore), Newton + Gauss–Legendre, 64-entry memo, counter-based tests |
| Report capture silently drops content | Missing disclaimers in PDFs | Six ≤ 600-character Notes boxes, verdicts < 299 characters, chip in `rp-skip`, UI test 6 |
| Sidebar or tests churn | Failing sidebar/report tests | Q1 decided before code; Option A needs no HUBS change; append `cheminj` in the final template |
| Hydrate page and new page disagree (2.2×) | Confusion | Banner on the Hydrate page, margin stated in every verdict, Phase 2 fixes |
| Unrelated failures at HEAD | Gates cannot pass | Prerequisites §9.1 |

### 9.8 Open questions for the user

Decide before any code: **Q1, Q2, Q5, Q17, Q18, Q19.**

1. **Sidebar:** Option A, `cheminj` as the 8th row of Test System Safety (recommended for 3.2a; the group then reaches the 8-row limit), or Option B, a hub "Hydrate, H2S & Chemicals" (`cheminj`, `hydrate`, `h2sroe`), which changes the agreed HUBS?
2. **Hydrate page:** may 3.2a add the one-line banner (Round-5 rebuild, `rp-skip`)? May Phase 2 fix 25-hydrate.js (publish state, use the user margin, correct the impossible default back-pressure-valve node)? Should its rate later come from the new engine (this changes its numbers and the G4 tests)?
3. **MEG model:** design on the larger of Nielsen–Bucklin and Hammerschmidt (in practice NB, default), or source measured data for a fitted correction?
4. **Methods:** ship with Hammerschmidt + Nielsen–Bucklin only until the Moshfeghian–Maddox / Østergaard papers are available?
5. **Margin:** 10 °F when T_hyd comes from the correlation (recommended), or keep the app's 5 °F?
6. **Condensed water:** keep Bukacek as default with "all water condenses" as an option, or make the conservative option the default below 60 °F?
7. **Scavenger utilisation:** plain user input with point defaults and a contact-time ⚠ (recommended), or auto-lower η from contact-time bands (≥ 20 s 0.60, 10–20 s 0.50, < 10 s 0.40; low confidence)?
8. **H2S outlet targets:** confirm the list (4 ppm, 5 mg/m³ at the active base, 10 ppm, 1 ppm, flare-SO2-driven, custom).
9. **Pump presets and margins:** ship generic illustrative families (recommended) or a blank custom pump only? Is the company pressure margin +10 %/100 psi, or +200 psi at wellhead points? Default rating basis "max credible back-pressure" (recommended) or "full tie-in class"?
10. **ESD philosophy text:** should chemical pumps (especially hydrate methanol) trip on ESD or keep running for shut-in protection?
11. **Hazardous area:** keep `cj_haz` default "yes" (pumps in a classified area)?
12. **Viscosity:** make data-sheet viscosity a required input for products (placeholders otherwise)?
13. **Drive gas:** report both the first-principles estimate and the 13.3 scf/h regulatory default to Flare & GHG, or the default only?
14. **Live data:** Modbus verification in Phase 3 (proposed) or earlier?
15. **Custom product library:** per well (default) or cross-project?
16. **Water basis default:** "free water at wellhead" (planning, default) vs "measured at separator"?
17. **J-T design factor:** default 1.10 (recommended; methane bias up to 1.089, Katz chart case) and allow relaxing to 1.05 once the GPSA chart values confirm V2?
18. **Sour limit:** refuse the correlation dose above 3 mol % H2S unless a user T_hyd is entered (recommended), or allow it with a larger adder?
19. **Default pump for H1:** air-driven liquid pump (recommended; no pneumatic plunger can do the duty, no electrics in the classified area) or the electric plunger pump?
20. **Ambient default:** 60 °F for the shut-in and start-up cases (H1), or another site default?

---

## 10. References (standards, books, papers)

**Hydrates and inhibitors**
- Hammerschmidt, E.G. (1934). Formation of gas hydrates in natural gas transmission lines. *Ind. Eng. Chem.* 26(8), 851–855.
- Katz, D.L. (1945). Prediction of conditions for hydrate formation in natural gases. *Trans. AIME* 160, 140–149 (permissible-expansion charts, reproduced in the GPSA Engineering Data Book, Section 20).
- Nielsen, R.B., Bucklin, R.W. (1983). Why not use methanol for hydrate control? (trade-journal article).
- Moshfeghian, M., Maddox, R.N. (1993). Method predicts hydrates for high-pressure gas streams (trade-journal article).
- Towler, B.F., Mokhatab, S. (2005). Quickly estimate hydrate formation conditions in natural gases (trade-journal article).
- Østergaard, K.K., Masoudi, R., Tohidi, B., Danesh, A., Todd, A.C. (2005). A general correlation for predicting the suppression of hydrate dissociation temperature in the presence of thermodynamic inhibitors. *J. Pet. Sci. Eng.* 48(1–2), 70–80.
- Moshfeghian, M. (2011). A simple model for estimation of methanol loss to the vapour phase (technical article).
- Moshfeghian, M. (2006, 2020). Accuracy of shortcut hydrate-inhibition methods; thermodynamic hydrate inhibitors compared (technical articles).
- McIntyre, G., Hlavinka, M., Hernandez, V. (2004). Hydrate inhibition with methanol — a review and new concerns over experimental data presentation. 83rd GPA Annual Convention.
- Bahadori, A., Vuthaluru, H.B., Mokhatab, S. (2008). Estimation of methanol vaporization loss and its solubility in hydrocarbon liquid phase (trade-journal article).
- Hemmingsen, P.V., Burgass, R.W., Pedersen, K.S., Kinnari, K., Sørensen, H. (2011). Hydrate temperature depression of MEG solutions at concentrations up to 60 wt%. *Fluid Phase Equilibria* 307(2), 175–179.
- Baillie, C., Wichert, E. (1987). Chart gives hydrate formation temperature for natural gas (trade-journal article).
- Kelland, M.A. (2006). History of the development of low dosage hydrate inhibitors. *Energy & Fuels* 20(3), 825–847.
- Kelland, M.A. (2014). *Production Chemicals for the Oil and Gas Industry*, 2nd ed.
- Almashwali, A.A., Bavoh, C.B., Lal, B., et al. (2022). Gas hydrate in oil-dominant systems: a review. *ACS Omega* 7(31), 27021–27037.
- Sloan, E.D., Koh, C.A. (2008). *Clathrate Hydrates of Natural Gases*, 3rd ed. Sloan, E.D. (ed.) (2011). *Natural Gas Hydrates in Flow Assurance*.
- Carroll, J. (2014). *Natural Gas Hydrates: A Guide for Engineers*, 3rd ed.
- Gas Processors Suppliers Association. *Engineering Data Book*, Sections 20 (Dehydration: hydrate inhibition, methanol solubility in liquid hydrocarbon, permissible expansion) and 21 (Hydrocarbon Treating).

**Gas properties, J-T and water content**
- Bukacek, R.F. (1955). Equilibrium moisture content of natural gases. Institute of Gas Technology Research Bulletin 8.
- McKetta, J.J., Wehe, A.H. (1958). Use this chart for water content of natural gases (trade-journal article).
- Wagner, W., Pruss, A. (1993). International equations for the saturation properties of ordinary water substance. *J. Phys. Chem. Ref. Data* 22, 783.
- Dranchuk, P.M., Abou-Kassem, J.H. (1975). Calculation of Z factors for natural gases using equations of state. *J. Can. Pet. Tech.* 14(3).
- Sutton, R.P. (1985). Compressibility factors for high-molecular-weight reservoir gases. SPE 14265.
- Wichert, E., Aziz, K. (1972). Calculate Z's for sour gases (trade-journal article).
- Peng, D.-Y., Robinson, D.B. (1976). A new two-constant equation of state. *Ind. Eng. Chem. Fundam.* 15(1), 59–64 (J-T cross-check).
- Setzmann, U., Wagner, W. (1991). A new equation of state and tables of thermodynamic properties for methane covering the range from the melting line to 625 K at pressures up to 1000 MPa. *J. Phys. Chem. Ref. Data* 20(6), 1061–1155.
- NIST Chemistry WebBook, Standard Reference Database 69: Thermophysical properties of fluid systems (methane isotherms at 250 K and 300 K, retrieved 2026-10-31).
- Reid, R.C., Prausnitz, J.M., Poling, B.E. (1987). *The Properties of Gases and Liquids*, 4th ed.
- *Handbook of Chemistry and Physics* (aqueous methanol and glycol freezing points, viscosities, compressibilities, thermal expansion).
- Kaye & Laby. *Tables of Physical and Chemical Constants* (methanol viscosity).

**H2S and scavengers**
- Romero Logroño, I.A., Kucheryavskiy, S., Maschietti, M. (2021). Experimental study of the aqueous phase reaction of hydrogen sulfide with MEA-triazine using in situ Raman spectroscopy. *Ind. Eng. Chem. Res.* 60(43), 15549–15557.
- Bakke, J.M., Buhaug, J., Riha, J. (2001). Hydrolysis of 1,3,5-tris(2-hydroxyethyl)hexahydro-s-triazine and its reaction with H2S. *Ind. Eng. Chem. Res.* 40, 6051–6054.
- Bakke, J.M., Buhaug, J.B. (2004). Hydrogen sulfide scavenging by 1,3,5-triazinanes. Comparison of the rates of reaction. *Ind. Eng. Chem. Res.* 43, 1962–1965.
- Wylde, J.J., Taylor, G.N., Sorbie, K.S., Samaniego, W.N. (c. 2020). Formation, chemical characterization and oxidative dissolution of amorphous polymeric dithiazine (apDTZ) during the use of the H2S scavenger MEA-triazine. *Energy & Fuels*.
- Schulz, M. (2018). Developments in H2S scavenging. *PTQ*.
- Jørgensen, E.T. CFD simulation of H2S scavenger injection. MSc thesis, Aalborg University.
- Tomson, M.B., et al. (2006). Scale formation and prevention in the presence of hydrate inhibitors. *SPE Journal* (SPE 80255).
- ISO 15156-1/-2 / NACE MR0175. Materials for use in H2S-containing environments in oil and gas production.
- API RP 49 (drilling and well servicing operations involving H2S); API RP 55 (production and gas processing operations involving H2S).
- ASTM D4810 (H2S in natural gas by length-of-stain tubes); GPA 2377; ASTM D5504 (sulfur compounds by GC-SCD).
- 16 Texas Administrative Code §3.36 (radius of exposure); UK Gas Safety (Management) Regulations 1996, Schedule 3.
- ACGIH TLVs; NIOSH Pocket Guide to Chemical Hazards (H2S, methanol, methyl mercaptan, hydrogen peroxide, nitrogen oxides).

**Pumps, pressure systems, safety**
- API Std 675, Positive Displacement Pumps — Controlled Volume (3rd ed., 2012).
- API Std 674 / ISO 13710, Reciprocating positive displacement pumps.
- API RP 14C, Analysis, Design, Installation and Testing of Safety Systems for Offshore Production Facilities (pump discharge protection, backflow).
- API RP 14E, Design and Installation of Offshore Production Platform Piping Systems (erosional velocity).
- API Std 520 Parts I/II and API Std 521 (pressure-relieving devices and systems, including thermal relief of blocked-in liquid).
- API Spec 6A (wellhead and tree equipment; pressure classes).
- ASME B31.3 Process Piping.
- API RP 500 / RP 505 (hazardous area classification).
- ASTM D1152 (methanol specification).
- 40 CFR Part 98 Subpart W, Table W-1A (natural-gas-driven pneumatic pump default emission factor 13.3 scf/h).
- White, F.M. *Fluid Mechanics* (Hagen–Poiseuille, Darcy–Weisbach); Swamee, P.K., Jain, A.K. (1976). Explicit equations for pipe-flow problems. *J. Hydraulics Div. ASCE* 102(5).
- University of Bath. The flow dynamics of an air driven hydraulic pump (research publication).

Verification note: the equations and check values were verified online by the research workstreams where marked (Nielsen–Bucklin constants, Hammerschmidt K for methanol/MEG, the methanol K-value correlation, Wagner–Pruss constants, the Bukacek range, the API 675 accuracy, the Subpart W factor) and, in this revision, the methane J-T reference values (NIST). The Katz-chart readings and the Baillie–Wichert magnitudes are from memory and carry confidence tags. Every number in this revision was re-computed with `rev_jt.js` and `rev_calc.js` (and the earlier `plan_calc*.js`), and the host-engine figures with `rev_app.js` through the test harness.

---

## Appendix A. Review log (review round 1)

Two reviewers raised 48 issues. "Fixed" means the change is in this revision; changed worked examples were re-computed with `rev_jt.js` / `rev_calc.js`.

| # | Sev. | Issue | Resolution | Where |
|---|---|---|---|---|
| 1 | critical | Downhole rating (3,253.5 psig) and PSV band below SITHP 3,500 psig; Note 4 contradicted it | Fixed. Rating ≥ max(1.10·P_req, P_req + 100, 1.10·P_back, P_back + 100) with P_back = SITHP for `dh`/`wh`; PSV set never below P_back; ✗ "discharge circuit rated below the shut-in wellhead pressure"; optional full-class basis. D1 rating now **3,850 psig** (test N32), PSV ≥ 3,500 | D10, §3.1, §4.11.1–2, §4.13 D1, N31–N32 |
| 2 | major | Surface rating from operating pressure; no backflow or tank blow-by coverage | Fixed. P_back = tie-in MAWP, new input `cj_psvsep` (separator PSV set, default 1440 psig); H1 `dsch` rating 1,584 psig. Summary ⚠ and Notes box 3: two checks + block + bleed, tank vent for blow-by or low-discharge-pressure trip, pump PSV does not protect the tank | §2.3, §3.1, §4.11.1, §8.1–8.2, N31, N40 |
| 3 | major | DAK under-predicts J-T cooling ~10 %; [H] tag and "real answer" overstated; second-expansion verdict likely flips | Fixed. Method tagged [M]; validated against NIST methane μJT (NIST/DAK 1.00–1.09) and the Katz chart; design factor f_JT = 1.10 (H1 34.56 °F, close to PR 35.84); second expansion now ✗ (43.27 vs 44.06 °F); D3 rewritten. N7 stays tight (±0.3 °F) as a self-consistency check of the solver; accuracy is tested by V1–V2 rather than by widening N7. "Design on min(DAK, PR)" not adopted: PR needs a composition that gas gravity does not give, and it over-predicts methane μJT by ~17 % | D3, §4.1.1–4.1.4, §4.13, V1, V2, N7, N15 |
| 4 | major | Water carried by aqueous chemicals left out of m_W; triazine upstream of a cold choke unchecked | Fixed. Σ w_j·ṁ_sol,j of active aqueous lines upstream of the controlling node added to m_W; `water` field in chemlib; ⚠ when no THI line protects the node. H1 + S1 line: +171.8 lb/d → m_W 1,224.7 (the reviewer's 1,204 was on the old 1,032.5 baseline) | D4, §3.2 rule 8, §4.4, §5.1, N39 |
| 5 | major | Flat +5 °F sour adder up to 10 mol % H2S is non-conservative | Fixed. Adder 5 °F per mol % H2S from 1 to 3 mol % (≥ 5 °F); above 3 mol % the correlation dose is refused unless a user T_hyd is entered; CO2 > 20 mol % refused. Tests at 2 and 5 mol % | D7, §4.2, N17, Q18 |
| 6 | major | KHI screened on flowing subcooling only | Fixed. Screening on the largest subcooling over flowing, shut-in and start-up, with hold time vs planned shut-in. H1: flowing 28.6, shut-in 20.8 (30.8 at 50 °F), start-up 89.8 °F → KHI ✗ | §4.6, N16 |
| 7 | major | Sour drive gas not flagged; supply setting from operating pressure | Fixed. ✗ for sour produced drive gas with exhaust H2S shown; `cj_supgas` input (default instrument air); P_s,set from the shut-in design pressure plus a 5 psi spring offset: S1 35.3 psig (the flowing basis would stall), 1,000 scf/d | D14, §3.2 rule 10, §4.12.3, §4.13 S1, N35 |
| 8 | major | Oxidiser hazards missing; peroxide/nitrite "A" at tank | Fixed. Tank → N with the O2/NOx verdict; "never block in; vented relief"; NOx/acid note for nitrite; chemlib cautions and compat row | §3.2 rule 9, §3.3, §5.1, §5.4, N37–N38 |
| 9 | major | No thermal relief for blocked-in liquid-full lines | Fixed. α_v/β per chemical (methanol 77 psi/°F with the DB β 8.6×10⁻⁶ psi⁻¹; the reviewer's 78 used κ 1.23×10⁻⁹ Pa⁻¹; 2,300 psi for 30 °F); line row, Summary ⚠, Notes box 5 | §4.11.1, §8.1, N40 |
| 10 | major | Air-driven liquid pump deferred; H1 left with only an electric pump | Fixed. `air_liquid` in 3.2a with Q(P) curve, air setting, cycles/min and a mandatory drawdown/meter note; 6 and 8 in actuators and duplex pneumatic as candidates; ranking by hazardous-area suitability first; H1 default pump air-driven (45.6 psig air). Duplex pneumatic is modelled as two plungers on one actuator (pressure halves); "two pumps in parallel" is a suggestion, not a ranked candidate | D13, §4.10.3, §4.10.6, §5.2, N28, Q19 |
| 11 | minor | Hammerschmidt ≤ 25 wt % less conservative; step at the switch | Fixed. W = max(W_Ham, W_NB) for methanol, ethanol and MEG; Hammerschmidt shown for reference | D6, §4.3, N5 |
| 12 | minor | Shut-in MEG by Hammerschmidt (48.3 wt %) breaks D6 | Fixed. NB reported, Hammerschmidt shown. With the H1 ambient now 60 °F (see A.2): MEG 47.99 wt %; at 50 °F the reviewer's 56.01 wt % is kept as a second fixture | §4.7, N14 |
| 13 | minor | Lean-solution formula ignores water in the extra lean solution | Fixed. Rigorous L = [X_R·m_W + (m_vap + m_LHC)(1 − X_R)]/(X_L − X_R); H1 lean 95: 1,154.8 lb/d (old form 1,140.2) | §4.5, N11 |
| 14 | minor | ppm identity row 3.36 gal/d | Fixed: 5.04 gal/d | §4.9, N18 |
| 15 | minor | AA "1–3 gal/bbl" contradicts 0.5–3 vol % | Fixed: guideline removed; range stated in vol % of water only | §4.6 |
| 16 | minor | 5 mg/m³ target base; SO2 avoided without CE | Fixed. Target computed from the active base (3.47 ppm at 15 °C, 3.29 at 0 °C); SO2 avoided = so2(y_in) − so2(y_out) from `WTS_h2s_so2` = 38.05 lb/d | §2.3, §4.8, N20, N23 |
| 17 | minor | D1 viscosity and SG inconsistent with the stated method | Fixed. SG and μ at the mean of tank and CIV temperatures (0.7645, 0.397 cP, computed), cold SG 0.796 for the siphon; μ-forced cases labelled; glycol-cold ⚠ | §4.11.2–4.11.4, §4.13 D1, N32–N33 |
| 18 | minor | "7 °F/100 psi … conservative" not true when cold and at low pressure | Fixed: label now "quick check; overstates cooling above ~2000 psi, may understate it below ~1000 psi and 40 °F"; cold μJT values tabulated | §2.3, §4.1.4–4.1.5, §8.2 |
| 19 | minor | Newton slope stated as μJT | Fixed: slope is Cp(T₂, P₂) = ∂h/∂T|P; μJT is used only for the predictor | §4.1.2 |
| 20 | minor | Two turndown thresholds | Fixed: one rule, ⚠ if f < max(0.10, S_min·N_min), in §4.9 and §4.10.4 | §4.9, §4.10.4–5, N27 |
| 21 | minor | Swept vs delivered mL; hhp pressure; totes vs refills | Fixed. Swept and delivered shown (3.89 / 3.50 mL at H1's electric alternative); hhp at P_req (0.23 hp); totes on site = ceil(inventory/247.5), tote changes = totes − 1 with contingency included (H1: 4 and 3) | §4.10.1, §4.11.1, §4.12.2, N28, N34 |
| 22 | minor | ppm product vs active; SG ratio missing in `ppm_per_ppm_o2` | Fixed. "Product (as supplied)" labels with optional active %; SG_w/SG_c applied (bisulfite example 0.163 gal/d, was 0.210) | §4.9, N18 |
| 23 | minor | Flat condensate loss f_c | Fixed. f_c scaled by x_MeOH/x_ref with the reference at 30 wt %, ~40 °F; labelled paraffinic | §4.5, N11 |
| 24 | minor | Methanol hazards missing (flammable produced water, NPSH, salt/scale) | Fixed. Notes box 4, chemlib caution, flooded-suction/shaded-tank note in the pump section | §4.10.2, §5.1, §8.1 |
| 25 | minor | Solenoid and mechanical diaphragm best fit at separator outlets | Fixed. "Tank or low-pressure points; separator outlets only when P_sep + allowance < P_max"; the engine's pressure check drives feasibility | §3.1, §5.2 |
| 26 | minor | S1 coil velocity near erosional; assumed choke-outlet T | Fixed. S1 choke outlet 300 psig and separator 285 psig; T after the choke from the isenthalpic solver (59.9 °F design); highest v/v_e 62 %; contact time 8.45 s (still ⚠); erosional ⚠ added to the engine | §4.8, §4.13 S1, N22 |
| 27 | minor | Patents and a borderline author/firm name in the references | Fixed. Patent citations and one further textbook entry removed (GPSA and Kelland cover the same material). No brand, product or supplier names, and no forbidden word | §10 |
| 28 | major | Single long Notes box and long verdicts would vanish from reports | Fixed. Six flat `<div><b>Notes</b> …</div>` boxes of 356–542 characters; every verdict < 299 characters; UI test 6 checks capture | §2.2, §6.6, §8.1–8.2, UI 6 |
| 29 | major | Off-line card headers and chip text would land in reports | Fixed. One "Number of injection lines" select; whole line cards hidden; chip outside `.card-title` in `rp-skip`; every toggle labelled/aria-labelled | §2.2–2.3, §6.6, UI 6, UI 8 |
| 30 | major | Solver cost and restore cost | Fixed. Newton with Cp slope + 40-point Gauss–Legendre (~1 ms per solve, prototype); 64-entry memo kept across calcs; heater alternative as an inverse root-find; `hooks.silent` + `after` (one calc on restore); solve counter for tests; combination loop on `WTS_cheminj_compute` | §4.1.2, §4.1.5, §6.2, §6.9, N44 |
| 31 | major | Hub name and decision; conflicting Hydrate-page dose; different margins | Fixed. Option A (8th row, recommended) or Option B hub "Hydrate, H2S & Chemicals" as user decision Q1 before code; Hydrate-page banner (2.2× gap at the same ΔT: 72.9 vs 160.0 gal/d); margin stated in the table title and every verdict; HUBS test updated in the same commit for Option B | D11, D16, §2.7, §9.8 |
| 32 | major | 25-hydrate keys and silent clamps | Fixed. Explicit key map, `etoh` never passed, invert ≥ 79.99 → out of range (✗), DEG/TEG limits, γ ⚠ raised by cheminj | §4.2, §4.3, N4, N13, N42 |
| 33 | major | gaspvt units (mol %, °F range) and cost | Fixed. New `WTS_gaspvt_z` (no −40 °F floor, one DAK solve) for every node and segment; all exports in mol %; ppm → mol % in one helper; test with 20,000 ppm | §3.1, §6.1, §6.3, N3 |
| 34 | major | Chemical change presets the point | Fixed. The point is never preset; preferred point shown as the suitability verdict; presets only chemical-property fields inside the canonical `#pgBody` event; Metric test (1041 L) | §2.4, UI 4 |
| 35 | major | ≈ 200 controls; phone columns; duplicate batch segments | Fixed. Batch uses the Card 2 segments; per-kind fields and Advanced toggles with a Design basis echo; one column on phones (host CSS), stated as such; jump bar; ≈ 60 controls visible on open | §2.2–2.3, §2.5–2.6 |
| 36 | major | MVP too large; size estimate low; prerequisites missing | Fixed. 3.2a (13–15 d) and 3.2b (9–11 d), each gated; prerequisites (failing test, 3.1.1 merge, perf baseline); size 120–180 KB | D15, §6.9, §9.1–9.3 |
| 37 | minor | Unit categories duplicate or mislabel existing ones | Fixed. Reuse `sandLoading`, `volPerMass`, `volumeSmall`; ΔP fields on `pressure`; seven new categories only, add-if-absent | §2.3, §6.5 |
| 38 | minor | Metric gui-sweep would flag imperial labels | Fixed. Chip, headers, cautions and totes via `_pair()`; metric dose bases preset in Metric | §2.5, §6.5, §6.7, UI 5 |
| 39 | minor | Reused tooltips contradict the page | Fixed. 3.2a ships without tooltips; 3.2b adds new entries with `data-wts-help` on labels | §6.6, §9.3 |
| 40 | minor | Simulator label matching; H2S import from raw storage | Fixed. `WTS_state.flow` (v 1) fields; `WTS_state.h2sroe` first, canonical writes in `runCanonical` + input/change | §2.3, §6.4 |
| 41 | minor | Constant gas gradient; laminar threshold; tubing capacity | Fixed. Gas column from `WTS_gradient_compute` (D1: 4,242.2 psig at depth, 0.093 psi/ft) with the override kept; laminar below Re 2000; `WTS_tubulars.capacity`; error text cited at L360 | §4.7, §4.11.2–4.11.4, N32, N36 |
| 42 | minor | Own-canvas fallback and resize listener | Fixed. `drawLineChart` directly (guarded), single-point markers, 2-point vertical lines, fixed 720 × 300 canvas, no resize listener | §2.5–2.6, §6.4 |
| 43 | minor | Scavenger engine returns `ok:false` at the edges | Fixed. Guards map no-H2S, target ≥ inlet and q = 0 to planned verdicts with rate 0; η clamped to keep R ≤ 10; engine message shown otherwise | §3.4, §4.8, N43 |
| 44 | minor | Quick Report template order breaks a test; daily consumption deferred | Fixed. `cheminj` appended at the end of the final template's Safety checks; daily template section in the MVP | §6.6, UI 10 |
| 45 | minor | Version bump missing from the gates | Fixed. RELEASE_NOTES, `MARKETING_VERSION`, both `VERSION_BASE` lines (3.2 / 3.2.1), CLAUDE.md stats | §7.4 |
| 46 | minor | Two similar sidebar names; unescaped imports | Fixed. Cross-link on the `chem` page; imported product names escaped | §2.7, §6.6, §6.8 |
| 47 | minor | ~20 flat `WTS_chem_*` globals; redundant registry fields | Fixed. `window.WTS_cheminj` namespace + `WTS_cheminj_compute`; `navTitle`, `badge`, `bc` dropped | §6.2–6.3 |
| 48 | minor | Data module triggers the Round-9 warning | Fixed. Header comment as in 40-calc-tubulars.js L9 and a smoke shape check | §6.1 |

### A.2 Further corrections found while re-checking

| Item | Change |
|---|---|
| Methanol vapour constant | 84,322 replaced by 10⁶·32.04/V_m = 84,431 lb/MMscf per mole fraction (follows the base conditions). N6 check value 12.80 → 12.81 lb/MMscf |
| Ambient inconsistency | The old plan used 50 °F for shut-in and 60 °F for start-up from one input. The H1 default is now 60 °F for both; 50 °F results are kept as fixtures (N14, N16) |
| Liquid gradient | 0.433 → 0.4335 psi/ft per SG (0.052 × 8.337), the constant used by `WTS_gradient_compute`, so the cross-check agrees exactly |
| Ranking | "Fewer heads" now comes before closeness to 45 %, otherwise a triplex 1/2 in (40.3 %) would outrank the simplex 7/8 in (39.5 %) at H1 |
| Air-driven pump stall | Stall at the design air (4,560 psig at H1) exceeds the rating; the plan states that the discharge PSV is the protection and adds a verdict |
| μJT table | Recomputed with the real-gas Cp (the old values agree within 0.001 °F/psi); 0 °F column and the Peng–Robinson comparison added |
| H1 ΔT arithmetic | The old row "63.13 − 41.42 + 10 = 31.73" (31.71 from the unrounded values) is superseded; the new row's displayed values add up (63.13 − 34.56 + 10 = 38.57) |
| Old 135-psig S1 coil | 135.6 ft/s was 92 % of the erosional velocity; the revised S1 keeps all segments below 62 % |
