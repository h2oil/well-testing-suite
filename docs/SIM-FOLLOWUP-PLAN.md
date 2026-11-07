# Simulator follow-up: heater inlet choke CK-102, bypass destination, cushion unload — implementation plan

> **Status: plan, reviewed** (2026-11-06; revision 2 after the plan review — the changes are listed in the Review notes
> appendix). **WP0 done** on `sim-fu` (contract, frozen copies, tools; re-anchored numbers in Appendix B); WP-E0 onward not built. Target: the next point release after the Help-centre release (v3.3.3 if Help ships as v3.3.2; the
> version is fixed at WP-I, §13). Built in work packages WP0, WP-E0, WP-C, WP-E1, WP-E2, WP-3D, WP-L,
> WP-2D, WP-HC and WP-I on a feature branch `sim-fu`. It replaces WP-SIM of `docs/HELP-GUIDE-PLAN.md` §8, which it takes over
> in full (bypass destination §8.1, cushion unload §8.2, tests §8.3) and corrects where the audit found problems (§1.4).
> Requests:
> - The product owner: *"Well Test Simulator — also when going through heater, heater should have its own choke too on inlet"*.
> - A field well tester asked how to unload the completion cushion straight to the burner boom or to a production line.
>
> Equipment, methods and standards are named generically, by standard designation or correlation author only. No other
> company, product, vendor or website is named.

| | |
|---|---|
| Release | **Next point release** (v3.3.3 provisional). One increment, no feature flag. **Default state:** CK-102 is an optional rig-up item, out by default. The bypass destination defaults to the burner / flare line, and no cushion runs unless the user starts one. In that state, **with V-101 in**, the engine results, the 3D scene and the 2D schematic are those of v3.3.1 for every flow (`SAMPLE_FLOW` and host-generated flows, which now carry the `flow.ck2` / `flow.sepBy` blocks). **With V-101 out**, the D3 change (whole-stream back pressure from the destination) applies to every host flow; only `SAMPLE_FLOW` and old flows without `flow.sepBy` keep the v3.3.1 law |
| What | (1) **CK-102 heater inlet choke**: an adjustable choke on the H-101 inlet, downstream of the heater-bypass tee. It is in line only while the stream goes through the heater. Two-stage choking with a pressure between the chokes, the regime of each choke, which choke limits the rate, J-T cooling per stage, and a hydrate check at the CK-102 outlet. A cheap **position option** puts CK-102 between the coil passes instead (`inlet` default, `midcoil`). (2) **Bypass destination** with V-101 out: the burner / flare line, or a production line at P psig. `pDown()` and the steady choke walk use the real destination pressure instead of the separator pressure. With the line destination the flare may also be out, and the totals go to the line. (3) **Cushion-unload scenario**: cushion volume, SG and unload rate. The tubing column sets WHP, the bean limits the liquid rate, then come gas breakthrough, a volume-balanced tail and "cushion recovered" totals by destination. (4) **Protection** for the new pressure breaks: the line between the chokes (PAH-102, blocked-in check against a stated design pressure) and the production-line tie-in (non-return and isolation valves, PSHH-104 on the bypass path) |
| Where | Well Test Simulator, Round 7: engine `prism-build/31-wts-sim.js`, 3D `prism-build/32-wts-3d.js`, live controller / HMI `prism-build/38-wts-live.js`. Host `well-testing-app.html`: `calcWTS` walk, the display-only `wtsRenderResults`, Heater and Dynamic Simulation inputs, the live 2D overlay of `wtsDrawDiag`, release notes. Tests and tools in `prism-build/tests/` and `prism-build/` (and `wts-host-patch.js` done markers, WP-C). Help content (`48-calc-help-welltest.js`, `48-calc-help-simcourse.js`) and the two Help tests that check it (`help-content.test.js`, `help-course.test.js`) only in WP-HC, **after** the Help release has merged; the minimal WP-HC part is **M** for this release (§11) |
| Not touched | PRiSM, calculators, the Help page UI and tooling (`49-calc-help*.js`, `help-shots.js`, `help/**`), the Modbus station, Mini WellOS panels (follow-up), the base fields of the `calcWTS` output (D2), the static page diagram (§8.2) |
| Inputs | Session notes `simfu/audit.md` (code audit at `3611343`, line numbers below are from it), `simfu/research.md` (engineering basis), `simfu/ck2.js` (approximate two-choke re-solve). This plan copies everything a builder needs. The model for structure and gates is `docs/SIM-EQUIPMENT-PLAN.md` (v3.3.1) |

**Conventions.**
- Units: field units (psig / psia, °F, ft, ft/s, bbl, bbl/d, Mscf/d, MMscf/d, 64ths of an inch for beans). Engine time is
  in seconds, as today.
- Labels: "ASSUMPTION" marks a modelling choice with no published correlation behind it. MoSCoW tags: **M** must, **S**
  should (drop only with the lead's agreement), **C** could.
- Code style: ES5 as in the Round-7 sources (`var`, `function`; no `let` / `const` in 31/32; no `??`, `?.` or `=>`). No
  timers, polling or function wrapping in any file.
- Line numbers: the v3.3.1 tree at `3611343` (`31-wts-sim.js` 4,307 lines, VERSION 1.4.0; `32-wts-3d.js` 4,725;
  `38-wts-live.js` 3,988; host `renderWTS` l.129378, `calcWTS` l.129452, `WTS_DIAG_LAYOUT` l.129722, `wtsDrawDiag`
  l.129736).
- "Out of the rig-up" for an optional item means absent and hidden, not ghosted (SIM-EQUIPMENT-PLAN D18).

---

## 0. Decisions at a glance

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | CK-102 in the rig-up | Optional item `heaterChoke`, tag **CK-102**, `optional:true, def:false, needs:'heater'`. `RIG_KEYS` is appended, so the signature grows to **11** characters (default `'11111111000'`). It is placed after `choke` in process order. CK-102 is in line only while flow goes through H-101: with `wts_bypass = 1` or H-101 out it is **bypassed** (in the rig-up, not active, with a card note) | The owner asked for it "when going through heater". In 3D the heater-bypass line E3b tees off upstream of the heater inlet leg E3c (32 l.212-213), so CK-102 sits on E3c. The append-only signature and out-by-default rule keep every saved v3.3.1 rig-up and project unchanged (SIM-EQUIPMENT-PLAN D2/D3) |
| D2 | Where the steady two-stage solve lives | **Dual walk in the host `calcWTS`.** It publishes today's walk unchanged in the existing fields (`flow.nodes.length === 8`, `flow.choke`, `flow.segs`, `flow.warnings`, `flow.sim.surgeP_psig`) and adds blocks computed whenever their inputs exist: `flow.ck2` (CK-102 in line), `flow.sepBy` (V-101 out to the chosen destination) and `flow.sepBy.ck2` (both). New warnings go only into `flow.ck2.warnings` / `flow.sepBy.warnings`. The engine picks the block in `derive()` from its own effective rig-up (one lead-owned `pickSteadyBlock()`, §5.2), so a rig toggle needs no calc re-run and has no ordering race. **`calcWTS` never reads the rig-up** (no `wts_sim_rigup` read). The page shows the rig-dependent rows through a display-only `wtsRenderResults(flow, rig)` (no save, no dispatch, no `setFlow`) that 38 calls from its `rigup` handler (§4.5) | The engine has no choke model: CK-101 is solved only in `calcWTS` (l.129540-129568). `calcWTS` ignores the rig-up, and a rig toggle never re-runs it (38 `setRig` l.1416). Leaving the base fields alone keeps wts3d-test l.144 and the Help release's FS-1/FS-2 page checks (Pout 20.5 / 157.7, Qmax 1.78) valid. A `calcWTS()` call from the `rigup` handler would be re-entrant inside `wts:calc` on project Open/New, add a `setFlow` per toggle and make the output depend on storage |
| D3 | V-101-out back pressure | `cfg.sep.bypass = {dest:'flare'|'line', P_psig, P_flare_psig, designP_psig}`. With V-101 out, `pDown()` = `P0 + ΔP_line·f²`. P0 is `flow.sepBy.P0_psig` when the block is present (the host's `P_FLARE_HDR` 5 for `flare`, `P_psig` for `line`), else `cfg.sep.bypass.P_flare_psig` (default 5, "burner / flare line inlet"; the PCV outlet setting `cfg.sep.pcv.P2_psig` then applies only with V-101 in). ΔP_line is the **multiphase** whole-stream seg-5 loss from `flow.sepBy.segs` when present, scaled by the mixture-rate fraction while a cushion flows (§6.2); without the block (old flow, `SAMPLE_FLOW`) the legacy gas-only `SS[4]·fg²` law runs unchanged. The `N.flare.Pline` inconsistency (l.2039 leaves out the loss that `pDown()` adds) is fixed only on the `flow.sepBy` path. **What changes for a user**: with V-101 out, every host-generated flow carries `flow.sepBy`, so the choke outlet uses the whole-stream loss. This is the intended fix | The identity scenario "(b) 1 h without separator" (wts-equipment.test.js l.469) runs on `SAMPLE_FLOW`. Gating on `flow.sepBy` keeps it `===` (the default `P_flare_psig` equals the default PCV setting; asserted), while the page path gets the correction |
| D4 | V-101 and FS-401 both out | Allowed only with `dest === 'line'` (note: "whole stream to the production line at P psig"). `normRigup(req, o)` takes `o.sepByDest`. A change of destination from `line` back to `flare` while both are out re-normalises, which forces the flare back in, with a note and a `'rigup'` event, on **every** path that changes the destination (`setConfig` and `setFlow` / `applyFlow`, one shared `rigRenorm()`; §3.3). With FS-401 out, relief and vent gas of the vessels still in the rig-up goes to a `vent` sink with its own total (§6.2). The line tie-in carries a non-return valve NRV-501 and an isolation valve XV-501, and PSHH-104 on the bypass path trips SDV-101 (D16) | Today the rule forces the flare in (l.173), so "no separator, straight to a production line" is impossible (FS-2). `setFlow` never runs `applyRig`, so a hook on `setConfig` alone would not enforce the rule on the page path |
| D5 | Cushion is a scenario, not a fault | `sim.startCushion(o)` / `stopCushion()` / `getCushion()`, through `mut()`. The Scenarios menu gets an item "Cushion unload (clean-up)" that opens a small form. Form values are device prefs (`h2viz3d_prefs.cushion`, a validated block in `readPrefs` / `writePrefs`), not host inputs, so the page report's Inputs are unchanged. The cushion is not persisted across a reload; Reset stops it. `FAULT_IDS` stays at 16. The cushion state lives in its own closure variable (`cushS`, with the boolean `cushOn`), not on `X` and not in the derived block, so `derive()` (every `setFlow`) never resets it | A fault has no inputs. Keeping the cushion out of the host form keeps the default report as it is |
| D6 | Cushion physics | Tubing column h_c = min(Vmain − Vprod, depth·cap)/cap with Vmain = V·(1 − tailFrac). Shut-in estimate `SIT = DD.sit` (entered SITHP) or `Rr.sithpFactor·Pwh_ss`. Column law (ASSUMPTION, straight-line deliverability in WHP): `WHPcol = SIT − (SIT − Pwh_ss)·fUnload − (0.433·SG − G_r)·h_c`, with `fUnload` the reservoir-volume rate of the unload over that of the steady flow (§6.3). WHP target = `max(pDown()+50, WHPcol)` with the existing noise factor. The liquid rate is `min(q_set, qLcap)`, with the liquid choke law on the equivalent bean across the **whole** choke ΔP (`CUSH_LIMIT` when the bean limits). A **stall** (all well rates 0, `CUSH_NOLIFT`) applies when the column law would put WHP at or below `pDown()+50`. Breakthrough comes when Vmain has been produced (delivered rate), located in `chooseH()`. After breakthrough only the formation streams blend in (w = 1 − e^{−t/breakTau}); **all** post-breakthrough cushion water is the volume-balanced exponential tail of tailFrac·V, so ∫cushion water dt = V exactly | Fixes the help plan's off-scale WHP law (150 bbl ÷ 0.00579 bbl/ft ≈ 25,900 ft of column, so WHP always sat on the floor) and its tail, whose integral `q_c·τ` exceeded V. Starting from the steady flowing WHP would understate WHP during a low-rate unload (drawdown is small) and stall wells that would unload. Answers the FS-1 limits ("bean never limits the liquid"; "WHP does not rise by itself") |
| D7 | Cushion defaults | 50 bbl, SG 1.03, 1,500 bbl/d, 3-1/2″ 9.2 lb/ft tubing (2.992″ ID, 0.00870 bbl/ft), depth 10,000 ft, reservoir-fluid gradient 0.08 psi/ft, gas fraction 5 % while unloading, tail 15 % with τ 1,800 s, breakthrough blend τ 600 s | A consistent set: the main slug (42.5 bbl) is a 4,885 ft column, net head about 1,790 psi; with SITHP 3,600 (1.2 × 3,000) and fUnload ≈ 0.19, WHP starts at about 1,700 psig and rises to about 3,490 at the end of the main slug; breakthrough after about 0.68 h, then the tail (§6.4). Supersedes HELP-GUIDE-PLAN Q15 (150 bbl in 2-7/8″ is not physical for a 10,000 ft string) |
| D8 | Cushion coupling (flow fraction, J-T, duty, velocities, separator) | All behind `cushOn`. (1) Warm-up: a flowing flag `cushS.qNow > 0` joins the gas-only `X.f > 0.05` test (l.1769). (2) **J-T**: the cushion liquid carries most of the heat capacity, so the choke and CK-102 cooling use a blended weight `wJTe` (gas cp share of the unload stream, blended to `chk.wJT` with w; §6.3). (3) **Duty is additive**: gas duty `duty_ss·X.f` plus the cushion liquid duty, capped at the H-101 rating (`cfg.heater.ratedFactor` 1.25 × duty_ss, ASSUMPTION); when the cap binds the outlet temperature falls to `Tin + rated/mcp` and `HTR_FULL` is raised. (4) Line velocities add the liquid term (l.2050). (5) **`Cv_w` stays fixed**: when q_set exceeds the V-101 water-dump capacity at the current ΔP, `startCushion` returns a warning text and `CUSH_DUMP` is raised; LAH / LSHH then act as on a real spread. The dump and WGRAD use the cushion SG (l.1573-1574) | Otherwise, at gas fraction 0.05 the spread cools to ambient, the duty is 5 %, the gas-mix J-T weight (0.56) cools a mostly-liquid stream about 20 times too much, and resizing the dump valve in mid-run would hide the real constraint of unloading through the separator (and is lost on the next `derive()` anyway) |
| D9 | CK-102 discharge coefficient and default bean | Shared `wts_Cd`. New input `wts_bean2` "Heater choke CK-102 bean (64ths)", default **48**, range 4–128 | At the defaults (CK-101 32/64, 10 MMscf/d) 48/64 puts about 1,135 psig between the chokes, and CK-101 stays critical (audit F4; re-anchored at WP0). The user sees the effect as soon as CK-102 is added |
| D10 | CK-102 position | `wts_ck2Pos` select `inlet` (default, as asked) / `midcoil` (**C**). Pressures are identical. The J-T cooling is capped **cumulatively** from the CK-101 inlet (150 °F in total, not per stage), and the linear law then gives the same total duty in both positions (§4.3); only the CK-102 inlet / outlet temperatures and its hydrate margin differ. The `midcoil` pass split (50 / 50) and the linear μJT after pass 1 are ASSUMPTIONS on the conservative side (real μJT falls as T rises, so the second-stage cooling is overstated). In 3D, `midcoil` moves the body to a crossover above the shell (or keeps the inlet body with the label "between passes" if WP-3D runs short) | With `inlet` both drops are taken on cold fluid: the staging spreads the drop and protects the coil, but does not prevent hydrates. `midcoil` heats first and is the field arrangement for hydrate risk (research §1.2, §1.7). Adiabatic chokes in series are isenthalpic overall, so the coil inlet temperature must not depend on the staging; a per-stage cap would cool a dry gas about 49 °F more just because CK-102 is in |
| D11 | Engine CK-102 pressures | Steady values from the block. Live: CK-102 inlet `Pm = max(Ph + (Pm_ss − Ph_ss)·fi², (Pm_ss + PSC)·fInst − PSC)`, which covers a critical CK-102, where the upstream pressure is ∝ rate. CK-101 outlet = `Pm + SS[2].dP·fi²`. A 5 s first-order lag on the CK-102 ΔP (like `DX.PD`) means a rig toggle or a live bean change does not step the choke outlet. **The lag value is a double on `X` (`X.ck2dP`), never on the derived `CK2` object**, so a `derive()` (every `setFlow`, including the bean change itself) keeps it. History `Pchoke` uses the same expression (one E0 helper `pckLive()`) | No choke physics per substep: algebraic re-scaling as the existing nodes do (l.2025-2031) |
| D12 | New alarms, no new faults | `CHOKE2_LIMIT` (alarm: CK-102 limits the pair rate). `CK1_SUBCRIT` (warning: CK-101 no longer critical). `PAH_CK2` (warning, PAH-102: pressure between the chokes ≥ 90 % of its design pressure). The CK-102 node joins the hydrate set (`HYD_heaterChoke`). V-101 out: `PSHH_SEPBY` (PSHH-104, trips SDV-101), `SEPBY_RATING` (warning). Cushion: `CUSH_LIMIT`, `CUSH_NOLIFT`, `CUSH_BURNER`, `CUSH_DUMP`, `HTR_FULL`. New quiet lists `Q_CK2`, `Q_SEPBY`, `Q_CUSH`. No new fault; `FAULT_IDS` stays at 16 | The owner did not ask for faults. Adding one would move the frozen fault count (fixture l.212). The two new pressure breaks need protection (D16) |
| D13 | Identity baseline | WP0 freezes **`tests/_wts-sim-v331.js`** (31 at `3611343`, self-test stripped as for v33). The new identity test runs v3.3.1 scenarios, **including DS-101 and T-202 in**, against it, on `SAMPLE_FLOW` **and** on a harness-`calcWTS` default flow (blocks present, V-101 in, CK-102 out). `_wts-sim-v33.js` and its tests stay. `wts-sim-perf.js` compares against v3.3.1 by default (`--base v33` keeps the old pair). Host: `tests/_wts-calc-v331.js`, golden `calcWTS` outputs for 12 input sets **written as literals** (no input set from the unmerged Help branch), generated at WP0 on the unchanged tree with `wts_sim_rigup` and `wts_page_wts` cleared; the base fields (listed in §9.2) must match with strict `===` (the refactor keeps the order of operations), and a frozen copy of the v3.3.1 `calcWTS` text (`tests/_wts-calc-v331-src.js`) is the timing baseline | The v3.3 frozen copy no longer covers what users have (DS-101, T-202). The host has no frozen engine, so a golden of its own output is the cheapest exact guard for D2. Real host flows carry the new blocks, so identity must be shown on one, not only on `SAMPLE_FLOW` |
| D14 | Versions | `WTS_sim.VERSION` 1.4.0 → **1.5.0**; `snap.v`, `getControls().v` and the flow `v` stay 1 (additive). `WTS_sim.features = {heaterChoke:true, bypassDest:true, cushion:true}` (HELP-GUIDE-PLAN D11 detection). The three are set by the same build and are always equal (asserted), so the Help FS-1 `afterSim` text, gated on `bypassDest` and also describing the cushion, is true whenever it shows. The app version is fixed at WP-I | The Help content switches its FS-1/FS-2 text on `features`; the Help branch's `help-course.test.js` l.351 requires `feature === 'bypassDest'` |
| D15 | Work split | WP0 (lead) → WP-E0 (31 foundation incl. `pickSteadyBlock`, the refresh hooks and the CK-102 accessor; 38 foundation) → WP-C (host walk) ∥ WP-E1 (CK-102 engine section) ∥ WP-E2 (bypass + cushion engine section). The views (3D, L, 2D) build in parallel against the frozen fixture. `Dev` (with Help) is merged into `sim-fu` **before** WP-L merges; the minimal WP-HC part is then M and ships with the simulator. Everything integrates on `sim-fu` and merges to `Dev` only at WP-I | E1 and E2 would otherwise edit the same `derive()` and `refresh()` lines; one selection function and named hooks keep them apart. Nothing half-built reaches `Dev` or Xcode Cloud |
| D16 | Protection at the new pressure breaks | **Between the chokes**: a stated design pressure for seg 3, the CK-102 body and (midcoil) H-101 pass 1, `cfg.heaterChoke.designP_psig` / host constant 1,440 psig (ASME B16.5 Class 600 at ambient, ASSUMPTION). Host: a warning whenever CK-102 is in and the **blocked-in** pressure (SITHP: the entered desander SITHP, else 1.2 × WHP) is above it. Engine: `PAH_CK2` from the live Pm. The text depends on the position (inlet: the coil is downstream of CK-102 and protected; midcoil: pass 1 sees Pm). **Production-line tie-in**: NRV-501 and XV-501 (text, 2D / 3D labels), PSHH-104 on the bypass path at 90 % of `cfg.sep.bypass.designP_psig` (default 1,440, ASSUMPTION) trips SDV-101; a blocked outlet is a stated limitation with `SEPBY_RATING` when line P plus the line loss exceeds the design pressure | CK-102 makes a pressure break: pinched, plugged or closed, the line between the chokes sees full SITHP (research l.27-28, l.146: the LP side has relief at its design pressure). With V-101 and FS-401 out nothing else protects the low-pressure spread against a blocked or back-flowing production line |
| D17 | Names | Public names for the separator (V-101) bypass use `sepBy`: inputs `wts_sepByDest` / `wts_sepByP`, flow block `flow.sepBy`, `flow.sim.sepByDest` / `sepByP_psig`, `snap.sepBy`, cumulative keys `toLine_*`. `wts_bypass`, `flow.heater.bypass` and `I.bypass` stay the heater bypass. One label per item, written once in `_wts-fu-shapes.js` `LABELS` and used by WP-C, WP-L and WP-HC: RIG_ITEMS name and NAMES "Heater inlet choke"; input labels "Heater choke CK-102 bean (64ths)", "CK-102 position", "With V-101 out, well stream to", "Production line pressure (psig)" | `wts_bypass_*` beside the heater bypass invited confusion and any future `/^wts_bypass/` pattern; the Help tests compare labels exactly. The labels match the Help branch's FS-1 / FS-2 `afterSim` text |
| D18 | Help interaction | The minimal WP-HC part is **M** for this release: `wts` reference `inputs[]` with the exact labels of the four inputs, `notDocumented` entries for 38's dynamic controls inside `#pgBody` (cushion dialog, bean2 buttons), verdict cases for the new ⚠ texts, the "Surge Tank Pressure" text (§4.5), and the test edits in `help-content.test.js` / `help-course.test.js`. The full content of §11 is S | The Help branch's `pageIssues()` fails for any id'd control not in `inputs[]` or `notDocumented`, and its FS-1 / FS-2 `afterSim` variants appear as soon as `features.bypassDest` is true, so the simulator cannot ship without them |

---

## 1. Scope

### 1.1 In scope
- CK-102 heater inlet choke: rig-up item, host two-stage walk, engine plumbing, alarms (incl. PAH-102), 3D body, live 2D
  glyph, HMI card and bean action, the `midcoil` position option (C).
- Bypass destination (burner / flare line or production line at P psig): host inputs, host walk from the destination, engine
  `pDown()`, rig-up rule on every path, accounting sinks (line, vent), tie-in protection (NRV-501, XV-501, PSHH-104), views
  and labels.
- Cushion-unload scenario (**M**): engine state and physics, Scenarios form, HUD, cards, history, totals by destination.
- Tests, perf gates (engine and `calcWTS`), frozen v3.3.1 engine and host golden, release items, the minimal help-content
  part (M, D18) and the full help-content update (S), both after the Help merge.

### 1.2 Out of scope (deferred, with the reason)
- A choke model inside the engine (the rate staying algebraic on the steady walk). The walk is steady, and a live line-pressure
  or bean change re-runs `calcWTS` through the existing `setHostInput` path. In a real well a subcritical CK-101 would let
  the rate and WHP respond to the downstream pressure; here they do not (stated in `CK1_SUBCRIT`).
- A heater-coil or LP-pass **relief valve** model (relief flow, set pressure dynamics) and a pressure-class input. The plan
  gives a stated design pressure with a blocked-in check and `PAH_CK2` (D16), not a relief path.
- A blocked production-line outlet as a dynamic case (line pressure rising to SITHP). Stated limitation, covered by
  `SEPBY_RATING` and PSHH-104 (D16).
- Multiphase critical choke correlations (Gilbert type) for the cushion. Liquid-only orifice law plus the gas walk (§6.3).
- An oil or diesel cushion to an atomising burner, burner turndown, and nitrogen lift / swab. The scenario flags the case
  (`CUSH_NOLIFT`, `CUSH_BURNER`) and does not model it.
- The elevation of a burner-boom riser or of a production-line run, and separate geometry for the production-line run: seg 5
  uses the flare-line geometry for both destinations (ASSUMPTION; optional length / NPS inputs are C later).
- A real-gas isenthalpic J-T per stage (`WTS_gaspvt_isenthalpic`): C later; the linear law with a cumulative cap stays.
- Mini WellOS / Modbus tags for CK-102 and the cushion (follow-up, as in v3.3.1 Q24).
- A suggested intermediate pressure (`argmax min(margin_CK101, margin_CK102)`): **C** for a later release (research §1.7).

### 1.3 User stories (each is an acceptance item in the named test)
| # | Story | Test |
|---|---|---|
| U1 | Add CK-102 in the Rig-up card; with H-101 in and the heater bypass shut it is in line, and the card, 3D, the live 2D and the Node table show the pressure between the chokes | wts-heater-choke, wts-fu-views |
| U2 | Pinch CK-102 from the card (bean2 −4/64); the pressure between the chokes rises without a step (also when a host input such as Thtr changes during the transient), and at 32/64 the pair becomes flow-limited with `CHOKE2_LIMIT` or `CK1_SUBCRIT` as computed | wts-heater-choke |
| U3 | Bypass the heater: CK-102 shows "bypassed with H-101", the walk returns to the CK-101-only values, and the change is continuous | wts-heater-choke |
| U4 | Take V-101 out, choose Production line 300 psig on the page (through `setFlow`): the choke outlet follows 300 psig plus the line loss, flame 0, the totals go to "to production line", FS-401 may be out, and switching back to the burner line forces FS-401 in | wts-bypass-cushion |
| U5 | Start "Cushion unload" with the defaults: WHP rises as the column shortens, breakthrough at 42.5 bbl delivered (to one substep), ∫cushion water = 50 bbl, hydrate warnings if the heater is cold at breakthrough and none while unloading with a warm heater | wts-bypass-cushion |
| U6 | With CK-102 out, dest flare, V-101 in and no cushion, every v3.3.1 snapshot path is `===` to the frozen v3.3.1 engine, on `SAMPLE_FLOW` and on a host-generated default flow | wts-fu-identity |
| U7 | Pinch CK-102 to 4/64 with SITHP above 1,440 psig: the page warns about the blocked-in line between the chokes and the engine raises PAH-102 | wts-heater-choke |

### 1.4 Corrections to HELP-GUIDE-PLAN §8 (WP-SIM), adopted here
| §8 text | Problem (audit) | Here |
|---|---|---|
| WHP = `Pwh_ss − 0.433·SG·(Vc/tbgCap)` with 150 bbl / 0.00579 | column 25,900 ft, so WHP always on the floor | §6.3: depth cap, net head with G_r, shut-in-based column law, D7 defaults, stall rule |
| tail `q_c·e^{−t/τ}` added to the formation water | integral 1,500/86,400·1,800 ≈ 31 bbl on top of V, so the cushion balance fails | volume-balanced tail of tailFrac·V that carries all post-breakthrough cushion water |
| `wts_sepByP` "pressure category" | the Dynamic Simulation card is untagged imperial (its D28 rule) | untagged psig (Q3) |
| `pDown()` = `P0 + SS[4].dP·fg²` | SS[4] is the gas-only Sep→Flare loss solved at Psep | multiphase `flow.sepBy` loss, legacy fallback (D3) |
| `calcWTS` reads `wts_sim_rigup` and changes its output | stale after a rig toggle; breaks the FS-1 page checks | dual walk; `calcWTS` never reads the rig-up (D2) |
| gas = gasFrac·qg, threshold logic unchanged | the spread cools to ambient while unloading | D8 |

---

## 2. Process topology and tags

### 2.1 Flow path (optional items in brackets)
```
WH-101 → SDV-101 → [DS-101] → CK-101 → seg 3 (Choke→Heater) → [CK-102] → H-101 coil → seg 4 → V-101 → …
                                                       └ heater bypass (wts_bypass) skips CK-102 and the coil ┘
midcoil option:  … seg 3 → H-101 pass 1 → [CK-102] → H-101 pass 2 → seg 4 …
V-101 out:       … seg 4 → [PSHH-104] → seg 5 (whole stream) → dest: burner / flare line (P0 = burner / flare line inlet,
                 cfg.sep.bypass.P_flare_psig 5) | production line (→ NRV-501 → XV-501 → tie-in, P0 = P psig)
```
The pressure break at CK-102: seg 3, the CK-102 body (and, for `midcoil`, H-101 pass 1) sit between the chokes and see full
SITHP if CK-102 is closed or plugged (D16).

### 2.2 New tags and ids
| Item | Tag / id |
|---|---|
| Heater inlet choke | `CK-102` (key `heaterChoke`, name "Heater inlet choke" in RIG_ITEMS and NAMES, HMI abbreviation `CK2`) |
| Between-chokes pressure alarm | `PAH-102` (alarm id `PAH_CK2`) |
| Bypass-path high-high pressure | `PSHH-104` (alarm id `PSHH_SEPBY`; trips SDV-101) |
| Production-line tie-in | `NRV-501` non-return valve, `XV-501` isolation valve (labels only; not simulated as valves) |
| Host inputs | `wts_bean2`, `wts_ck2Pos` (Heater card); `wts_sepByDest`, `wts_sepByP` (Dynamic Simulation card) |
| Alarms | `CHOKE2_LIMIT`, `CK1_SUBCRIT`, `PAH_CK2`, `HYD_heaterChoke`, `PSHH_SEPBY`, `SEPBY_RATING`, `CUSH_LIMIT`, `CUSH_NOLIFT`, `CUSH_BURNER`, `CUSH_DUMP`, `HTR_FULL` |
| Events / log | emit `'cushion'` `{type:'cushion', t, phase, msg}`; log `event` ids `CUSHION`, `BYPASS_DEST` |
| History | `Pck2` (CK-102 inlet, psig), `cushionLeft` (bbl) |
| Cumulative | `cum.lineGas` / `lineOil` / `lineWater`, `cum.vent` (FS-401 out); snapshot `toLine_gas_mscf`, `toLine_oil_stb`, `toLine_water_bbl`, `toVent_gas_mscf` |

---

## 3. Rig-up model (exact; WP-E0)

### 3.1 Items
`RIG_KEYS` (append only): `[…'flare','desander','surge2','heaterChoke']`. Signature 11 characters, default
`'11111111000'`.
`RIG_ITEMS` display order: `esd · desander · choke · heaterChoke · heater · separator · surge · surge2 · gauge · pump · flare`.
```
{ key:'heaterChoke', tag:'CK-102', name:'Heater inlet choke', optional:true, def:false, needs:'heater',
  why:'Optional: a second adjustable choke on the H-101 inlet. It takes part of the pressure drop and is in line only while the stream goes through the heater.' }
```
Exports: `RIG_DEFAULTS` gains `heaterChoke:false`, `RIG_OPTIONAL` becomes `['desander','surge2','heaterChoke']`, plus
`RIG_TXT.heaterChoke = ['CK-102', 'out of the rig-up', 'in line on the H-101 inlet']` (a missing key throws, l.2494).

### 3.2 Normalisation (`normRigup(req, o)`, pure)
```
optional k: r[k] = q[k] === true                                     (unchanged rule)
rules (after the existing ones, in this order):
  heaterChoke && !heater → heaterChoke = false;
      note 'CK-102 sits on the H-101 inlet, so with H-101 out of the rig-up CK-102 is out too.'
  separator === false && flare === false:
      o && o.sepByDest === 'line' → allowed; note 'V-101 and FS-401 out: whole stream to the production line at ' + P +
          ' psig (non-return valve NRV-501 and isolation valve XV-501 at the tie-in). Relief and vent gas of the tanks still in
          the rig-up goes to vent.'
      otherwise                    → flare = true (today's rule, l.173, with today's note)
sig / full / extras as v3.3.1 (extras in RIG_KEYS order)
```
Callers pass `{sepByDest: cfg.sep.bypass.dest, P: cfg.sep.bypass.P_psig}`: `applyRig` (l.451), the `setRigNow` check
(l.2526) and `rigRefusedNow` (l.2504). A call without `o` behaves as `dest 'flare'` (pure, fixture-tested). The surge /
gauge items are **not** forced out with V-101 and FS-401 out (nothing reaches them with V-101 out; they hold their
inventory), so the user's rig-up is not changed behind their back; their relief goes to the `vent` sink (§6.2).

### 3.3 Effective state (derive-time locals, hoisted; never read from cfg per substep)
```
rCk2    = rig.heaterChoke === true                      (in the rig-up)
ck2Act  = rCk2 && !bypassHeater                         (bypassHeater = !!I.bypass || !rHeater, l.592)
bypLine = !rSep && cfg.sep.bypass.dest === 'line'
ventOn  = !rSep && !rFlare                              (only possible with bypLine)
cushOn  = closure boolean, set by startCushion / stopCushion / reset (state, not rig; not touched by derive)
```
Persistent across `derive()` (never rebuilt there): `X.ck2dP` (the CK-102 ΔP lag, a double; set in `initState` by `fuInit`:
`CK2.dPss` when `mode === 'steady'` and `CK2.act`, so a steady start with CK-102 in line is steady at t = 0; 0 otherwise —
amended on `sim-fu-found`, Appendix B) and the closure `cushS` (cushion state, §6.3). Everything the derived `CK2` object
holds is reassigned from the flow on each `derive()`, and its lag lives only in `X.ck2dP`.

**One re-normalisation routine** `rigRenorm(reason)` (WP-E0) is shared by `setRigNow`, `setConfig` and `applyFlow`. It runs
`applyRig()` with the current `cfg.sep.bypass`; if the effective rig-up changed it applies the side effects once: quiet lists,
the `'rigup'` event and log `event` / `RIGUP`. Log `event` / `BYPASS_DEST` is written **only when the destination itself
changes** ('flare' ↔ 'line'), whatever the rig-up; a line-pressure change refreshes the notes and logs nothing (one `setFlow`
per keystroke on the page; pinned in wts-fu-foundation). `applyFlow` (l.2236-2242: `buildCfg` + `derive`) calls it when
`cfg.sep.bypass.dest` differs from the value of the previous flow, **before** `derive()`, so the D4 rule holds on the page
path (destination changed on the page → `setHostInput` → `calcWTS` → `setFlow`).

`setRigNow` additions:
- **CK-102 leaving** (rCk2 true → false): `quiet(Q_CK2)`. `X.ck2dP` decays from its value to 0 over its 5 s τ, so the
  CK-101 outlet does not step (U3). The same applies when `ck2Act` drops through the heater bypass (handled in `derive()`).
- **CK-102 entering**: `X.ck2dP = 0`, then lag to the steady value.

### 3.4 Persistence and callers (38 foundation, WP-E0)
- `writeRig` stores all 11 keys unless the request equals `RIG_DEFAULTS`. `applyFlow`, `fullRig` and `renderRig` follow the
  v3.3.1 rules for optional items. The predicate for "bypassed with H-101" is `rigIn(st,'heaterChoke') && (rigOut(st,'heater') ||
  bypassOn)`.
- `RIG_FALLBACK` (l.80) gets one row more.
- The 38 `rigup` handler calls the host's display-only `window.wtsRenderResults(WTS_lastCalc.flow, rig)` (guarded; no
  `calcWTS()` call, §4.5), after `writeRig`. 38 also calls it once on mount.
- `readPrefs` / `writePrefs` (38 around l.800) gain a validated `cushion` block: `{V, SG, q, tbg, depth}` numbers clamped
  by `DEFAULTS.cushion.lim`, `tbg` one of the four sizes; anything else falls back to the defaults.
- `inputsDiff` (38 l.363) logs `wts_bean2` (tag CK-102), `wts_ck2Pos` (CK-102), `wts_sepByDest` and `wts_sepByP` (V-101),
  pinned in wts-fu-views.
- Compatibility: a v3.3.1 request (10 keys) leaves CK-102 out. A v3.3.3 request opened by v3.3.1 has the unknown key ignored.

### 3.5 `stepFor(rig)`
Order `wellhead, esd, desander*, choke, heaterChoke*, heater, separator, flare, surge, surge2*, gauge, pump` (`*` counted
only when strictly true). The default rig-up gives today's ①–⑨. With CK-102 in: heaterChoke ④, heater ⑤ … pump ⑩. The
combinations (none / CK-102 / CK-102 + DS-101 / all three) are pinned in the new fixture.

### 3.6 Hard-coded counts that move (WP-E0 unless marked)
The inventory is **made by a grep rule, not a line list**. WP-E0 runs, and records the result in `_wts-fu-shapes.js`
(`COUNT_SITES`, file:line:text):
```
grep -nE "'1111111[01]*'|\{10\}|\{9\}|length, ?(9|10)\b|=== ?(9|10)\b|\b(9|10) (rig|items|keys|nodes)" \
  prism-build/tests/*.js prism-build/wts3d-test.js prism-build/31-wts-sim.js prism-build/32-wts-3d.js prism-build/38-wts-live.js
```
Each hit is either changed (engine sig 10 → 11; 3D `rigSig` 8 → 9 characters when `heaterChoke` joins `RIG_GROUPS`) or
marked "not a rig count" in `COUNT_SITES`. Tests derive signatures from `SIG_DEFAULT` / `RIG_KEYS.length` wherever they
can instead of literals. Known sites (audit F5 and the review), all covered by the rule:

| File | Sites | Change |
|---|---|---|
| `tests/_wts-equip-shapes.js` | `SIG_DEFAULT` l.81, `checkShape` regex l.422 and its `RIG_KEYS` forEach, identityDiff sig rule l.513-514 | sig default 11 characters; regex `/^[01]{10,}$/`; the forEach takes `RIG_KEYS` from the module under test; tail rule accepts `/^0*$/` after the compared prefix (lead, WP0) |
| `tests/wts-rigup.test.js` | l.101, 119, 131, 133, 136 | 11 characters / keys |
| `tests/wts-equipment.test.js` | l.200, 290, 328, 540, 550, 555, 573, 625 | sig length 11; 11 rig items / stored keys; liveNodes 11 |
| `tests/wts-desander.test.js` | l.111 (`'1111111110'`) | derived from `SIG_DEFAULT` |
| `tests/wts-surge2.test.js` | l.70 | derived from `SIG_DEFAULT` |
| `prism-build/wts3d-test.js` | l.205, 209, 584, 587, 599, 756, 765, 896 | `RIGUP.length` 11; node count 11; 3D `rigSig` 9 characters (WP-3D for l.584-599) |
| `32-wts-3d.js` | `fakeSnapshot` sig l.1001, `RIG_GROUPS` l.263, self-tests l.4629, l.4674-4675 | WP-3D |
| `31-wts-sim.js` self-test | l.4256 (`RIG_OPTIONAL`, lengths, VERSION) | `'desander,surge2,heaterChoke'`, 11, `'1.5.0'` |

---

## 4. Host steady walk (WP-C; `well-testing-app.html`)

### 4.1 Inputs
| Id | Card | Label (`LABELS`, D17) | Default / range | Tag | Notes |
|---|---|---|---|---|---|
| `wts_bean2` | Heater | "Heater choke CK-102 bean (64ths)" | 48 / 4–128 | `count` via `WTS_units.tagInput` in `renderWTS` (no `22-units.js` edit, so no Round-4 rebuild) | row `rp-skip` and hidden while CK-102 is out of the rig-up (display, `wtsRenderResults`) |
| `wts_ck2Pos` | Heater | "CK-102 position" select `inlet` "On the heater inlet" / `midcoil` "Between the coil passes" | `inlet` | — | as above; C |
| `wts_sepByDest` | Dynamic Simulation | "With V-101 out, well stream to" select `flare` "Burner / flare line" / `line` "Production line" | `flare` | — | always shown |
| `wts_sepByP` | Dynamic Simulation | "Production line pressure (psig)" | 150 / 0–1440 | untagged imperial (card rule D28; Q3) | `rp-skip` and disabled while dest is `flare` |

All four are appended to `WTS_IDS` (l.129377). Autosave goes to `wts_page_wts`. Clamp with the `isFinite` pattern used for
`wts_Psurge` (l.129466), so an entered 0 is kept: `wtsClamp(isFinite(gv(id)) ? gv(id) : def, lo, hi)` (a production line
at 0 psig, i.e. an atmospheric tank or pit, is valid). `flow.sim` gains `sepByDest` and `sepByP_psig`, so `SAMPLE_FLOW_SIM`
goes from 7 to 9 keys. The fixture assert moves, and `SAMPLE_FLOW.sim` gets the two defaults ('flare', 150), which keeps
identity: 'flare' without `flow.sepBy` is the legacy path. The bean and position travel in `flow.ck2` (§4.4), not in
`flow.sim`.

**`wts-host-patch.js`** (wts3d-test l.782 runs `--check` on the live host): every `done` marker of its EDITS list (24
regionCalc / regionRender / regionWTS edits, e.g. `const WTS_IDS=[`, `const P_FLARE_HDR=5;`, `const jtOf=dp=>`,
`seg(6,Psurge,Tsi,'liquid')`, `Pci,Qmax:Qcap,flowLimited}`, `Downstream P (separator back-pressure)`,
`Max Rate at this ratio`, `function wtsEqChk(ctx,x,y,regime,limited){`, `window.wtsDrawDiag=wtsDrawDiag;`) must stay present
**exactly once** after the refactor, so the walk moves into `wtsWalk` without duplicating `const jtOf=dp=>` (one shared
definition above it) and `wtsEqChk` keeps its signature (§8.2). If a marker must change, WP-C updates
`wts-host-patch.js` (a WP-C file for this release) in the same commit. The WP-C gate runs
`node prism-build/wts-host-patch.js --check`.

### 4.2 One walk function
Refactor the fixed point (l.129554-129568) into `wtsWalk(o)` with
`o = {P0, seg5:'none'|'gas'|'multi', heater:true|false, ck2:null|{bean, pos}, qs}`. `o.qs` (default 1) scales the mass and
volume rates that `seg()` and the nozzle law use (`mdG`, `mdO`, `mdW`, `Qg`), so the walk can be evaluated at a trial rate
(step 5) without touching the `calcWTS` locals; `seg()` takes the rates from its argument instead of closing over them.
Call it up to four times:

| Call | `o` | Published as |
|---|---|---|
| base | `{P0: Psep, seg5:'none', heater:true, ck2:null, qs:1}` | existing fields, strict `===` to the golden (§9.2) |
| ck2 | base + `ck2:{bean: wts_bean2, pos}` | `flow.ck2` |
| sepBy | `{P0: dest==='line' ? P : P_FLARE_HDR, seg5:'multi', heater:true, ck2:null, qs:1}` | `flow.sepBy` (`P0_psig` published) |
| sepBy + ck2 | sepBy + `ck2` | `flow.sepBy.ck2` |

Heater out (V-101-out walks): the walk always includes the 5 psi heater drop and publishes it as `heater.dP = 5`. The engine
leaves that term out when H-101 is out. The segment losses are not re-solved for it (an effect of at most 5 psi; stated
limitation). The base walk is computed first and read-only; the extra calls must not mutate shared locals (the golden test
catches it). The rig-up is never read (D2).

**Cost budget.** Closed forms and bracketed solves instead of nested bisections: a critical CK-102 is closed-form, a
subcritical one is an Illinois (regula falsi) solve on r with tolerance 1e-9 and at most 30 steps, and `QmaxPair` is an
Illinois solve on Q with at most 30 walks. The `calcWTS` timing gate is in §10.

### 4.3 Two-stage equations (inside `wtsWalk` when `o.ck2`)
Notation: `Pa = P + 14.696`. The nozzle law is the one `calcWTS` already uses for CK-101 (API 14B gas form, same `Cd`, `k`
and critical ratio `rCrit`, `preFac`, `fInner(r)`). Do not use the research note's coefficients (Q12).

**Guard first**: if the gas rate is not positive (`Qg·o.qs ≤ 0`, a liquid-only well) the block is skipped and published as
`{v:1, bean, pos, skipped:true, note:'no gas rate: the two-stage gas walk does not apply'}`; the engine then treats CK-102 as
in line with ΔP 0 and the note (§5.2).

1. **Heater inlet** `Phi2`: walk back from P0 through seg 4 (and seg 5) and add the heater drop, as the base walk does.
2. **Outer fixed point** on `(Pm, Pco2, T3, Z3)`, a fixed **8 iterations** (no convergence test, so the result is
   deterministic), started from `T3 = Tco2 = Tci − jtOf(Pci − Phi2)` and `Z3` at `(Phi2, T3)`:
   - **CK-102 upstream pressure** `Pm` at rate Q, bean2 (area A2) and the current `T3`, `Z3`:
     ```
     critical if Phi2a / Pma ≤ rCrit:   Pma = Q / (preFac(A2, T3, Z3) · √fInner(rCrit))          (closed form, linear in Q)
     else: Illinois solve on r ∈ (rCrit, 1) of  Q = preFac · Pma · √fInner(r),  Pma = Phi2a / r   (one root)
     ```
   - **Seg 3** from the CK-101 outlet `Pco2` to `Pm`: `Pco2 = Pm + seg3.dP(Pco2, Tco2)` (one pass per outer iteration,
     which replaces the 6 inner passes of the base walk).
   - `Tco2 = Tci − dT1`, `dT1 = jtOf(Pci − Pco2)`; `T3` = seg-3 outlet temperature (existing segment law); `Z3` at `(Pm, T3)`.
3. **No-flow guard**: if `Pco2 ≥ Pci − 0.5` (CK-102 back-pressure plus the seg-3 loss reaches the choke inlet, e.g. bean2
   near 4/64 or a high rate), set `regime 'No Flow'`, `noFlow true`, `flowLimited true`, and take `QmaxPair` from step 5;
   the warning text is "No flow at this rate: CK-102 back-pressure reaches the CK-101 inlet".
4. **CK-101 regime and capacity** from `Pco2 / Pci`, exactly as l.129564-129568 (`regime`, `QmaxMMscfd` at that ratio).
5. **Pair capacity** `QmaxPair`: the largest Q for which the walk at `qs = Q/Q0` is **feasible** (no-flow guard not hit) and
   CK-101 passes Q at the ratio that walk gives. Illinois solve on Q over the bracket [0, Qhi], where Qhi is the first of
   Q0·2^k (k = 0…4) that fails; the solve clamps at the infeasible edge (the function is not assumed monotonic past
   `Pm ≥ Pci`). `flowLimited = Q > 1.01·QmaxPair` (the base margin). **Limiter**: at `QmaxPair`, the choke that is critical
   there; `'CK-102'` when only CK-102 is critical, `'CK-101'` when only CK-101 is, `'both'` (joint limit) when neither is.
6. **Temperatures** (`jtOf(dp) = min(150, 0.07·wJT·dp)`, unchanged for CK-101). The J-T cooling is capped
   **cumulatively** from the CK-101 inlet, because adiabatic chokes in series are isenthalpic overall:
   ```
   dT1  = jtOf(Pci − Pco2);           Tco2 = Tci − dT1                       CK-101 outlet
   dT2  = max(0, min(150 − dT1, 0.07·wJT·(Pm − Phi2)))                        CK-102 stage (cumulative cap)
   T3   = seg-3 outlet temperature (existing segment law)
   Tho  = max(Thtr, Thi)  (the host heater outlet; the host has no bath temperature)
   inlet:   Tm_in = T3;   Tm_out = T3 − dT2;                         heater inlet = Tm_out
   midcoil: Tp1 = T3 + min(0.5·max(0, Tho − T3), max(0, Tho − 25 − T3));   Tm_in = Tp1;   Tm_out = Tp1 − dT2
   heater outlet Tout (unchanged); duty = mcp·(Tout − Tm_out) [+ mcp·(Tp1 − T3) for midcoil]
   ```
   The linear law gives the same total duty in both positions, `mcp·(Tout − T3 + dT2)`. With the cumulative cap the heater
   inlet temperature and the duty equal the CK-101-only walk's within the seg-3 loss term (heat loss to ambient at a
   different T3, and the different seg-3 ΔP), including a dry gas whose single stage is capped. The `midcoil` 50 / 50 split,
   the Tho − 25 °F cap and the linear μJT after pass 1 are ASSUMPTIONS on the conservative side (D10).
7. **Hydrate** at the CK-102 outlet: `Thyd(Phi2a)` (psia, as the existing per-node law takes) against `Tm_out`; at seg 3:
   `Thyd(Pma)` against `T3`.
8. **Blocked-in check** (D16): `sit = flow.sim.sithp_psig` (the `wts_SITHP` input) when finite, else 1.2 × WHP.
   `ratingOK = sit ≤ DESIGN_P_CK2` (host constant 1,440 psig, ASSUMPTION, B16.5 Class 600). When false, a warning
   (position-dependent text, §4.5) goes into `flow.ck2.warnings`. The flowing check `Pm > DESIGN_P_CK2` adds its own
   warning.

### 4.4 `flow.ck2` / `flow.sepBy` shapes (frozen in the fixture)
```
flow.ck2 = { v:1, bean, pos:'inlet'|'midcoil', Cd, skipped:false, note:'',
  regime:'Critical'|'Subcritical'|'No Flow', noFlow, flowLimited, limiter:'CK-101'|'CK-102'|'both',
  QmaxMMscfd (= QmaxPair), Pin: Pm, Pout: Phi2, dP, dTjt: dT2, Tin: Tm_in, Tout: Tm_out, hyd:{T, margin},
  ck1: { regime, Pout: Pco2, ratio, QmaxMMscfd, Tout: Tco2, dTjt: dT1, wJT },
  nodes: { choke:{P, T}, heaterChoke:{P, Pin, T, Tin}, heater:{P, T, Tin, duty} },
  segs: [seg3, seg4]                     (same shape as flow.segs[i]: vel, dP, ve, rhom, …)
  heater: { dutyMMBtuHr, Tin, Tout },
  sit_psig, sitEst, designP_psig: 1440, ratingOK,
  warnings: [ {t:'warn'|'info', msg} … ] }
flow.sepBy = { v:1, dest:'flare'|'line', P0_psig, noFlow, choke:{…as flow.choke}, nodes:{choke, heater, sep}, segs:[seg3, seg4, seg5],
  heater:{dP:5, …}, surgeP_psig, designP_psig: 1440, warnings:[…], ck2: <flow.ck2 shape> | null }
```
Neither block exists when its inputs are missing (Mini WellOS, old flows). The engine then uses the legacy path with a note
(§5.2). `flow.sepBy.surgeP_psig` is the entered Surge Tank Pressure clamped to 0–30 **without** the `Psep − 10` term (V-101
is out, so the separator pressure does not bound it); the base `flow.sim.surgeP_psig` keeps today's clamp.

### 4.5 Display (display only; the base fields never change)
- **`wtsRenderResults(flow, rig)`** (new host function, WP-C): renders the rig-dependent rows from a published `flow`. It
  does not save inputs, does not dispatch `wts:calc`, does not call `setFlow` and does not read storage. `calcWTS` calls it
  with no `rig` argument at its end; it then uses the last rig it was given by 38 (a host module variable, initially `null`,
  which means the v3.3.1 view). 38 calls it from its `rigup` handler and on mount (§3.4). The `wts_sepByDest` select is a
  page input, so the destination comes from `flow.sepBy.dest`.
- **Node table**: a row "Heater choke (CK-102)" while CK-102 is active, and "→ production line" or "→ burner line" as the
  last row while V-101 is out.
- **Choke rbox**: a line "two-stage with CK-102: P between chokes x psig, CK-101 regime" while CK-102 is active.
- **New rbox "Heater choke CK-102 (API 14B)"** (`.rbox` / `.rrow`, mirroring l.129630ff): bean, position, upstream /
  downstream P, regime, ΔP, J-T ΔT, outlet T, hydrate T and margin, pair capacity, limiter, design pressure and SITHP.
- **Warnings** come from `flow.ck2.warnings` / `flow.sepBy.warnings` and are shown by rig-up (⚠ verdict divs, plain text
  under 300 characters). `flow.warnings` is unchanged; while V-101 is out the display hides the base "surge too close to the
  separator" warning, because it does not apply:
  - "CK-102 limits the rate: bean x/64 passes y of z MMscf/d — open CK-102 or reduce the rate" (limiter CK-102)
  - "CK-101 and CK-102 together pass y of z MMscf/d — open either choke or reduce the rate" (limiter both)
  - "CK-101 subcritical with CK-102 in line (P2/P1 r above r_crit): in a real well the rate and WHP would now respond to the
    downstream pressure (not simulated)"
  - "No flow at this rate: CK-102 back-pressure reaches the CK-101 inlet"
  - inlet: "SITHP x psig above the 1,440 psig design pressure of the line CK-101 → CK-102: if CK-102 is closed or plugged
    this line sees full SITHP; the coil is downstream of CK-102"
  - midcoil: "SITHP x psig above the 1,440 psig design pressure between the chokes: if CK-102 is closed or plugged the line
    and H-101 pass 1 see full SITHP"
  - "Hydrate margin at the CK-102 outlet x °F"
  - sepBy: "Destination pressure makes CK-101 subcritical"; "No flow: destination pressure ≥ choke upstream pressure";
    "Production line x psig plus line loss y psi above the 1,440 psig design pressure of the bypass path (blocked outlet not
    simulated)"
- With the default rig-up and dest the page output is the v3.3.1 page exactly, so the Help FS-1 checks (a)–(e) keep passing.

### 4.6 Worked numbers (defaults: CK-101 32/64, 10 MMscf/d, WHP 3,000 psig; audit F4, approximate re-solve)
| CK-102 bean | P between chokes | CK-101 P2/P1 | T after CK-101 | Thyd there | heater inlet T | pair |
|---|---|---|---|---|---|---|
| 32/64 | — (no feasible state at 10 MMscf/d) | — | — | — | — | flow-limited; limiter **CK-102** (critical) with CK-101 subcritical; `QmaxPair` < 10 is computed by WP0 |
| 40/64 | ≈ 1,660 | 0.555 (at r_crit) | 128 | 67 | 68.7 | OK, marginal |
| **48/64** | **≈ 1,135** | 0.381 critical | 107 | 62 | 68.7 | OK (default) |
| 64/64 | ≈ 634 | 0.215 critical | 87 | 55 | 68.7 | OK |
| 96/64 | ≈ 278 | 0.097 critical | 74 | 44 | 68.7 | OK |

The earlier 32/64 row ("≈ 2,754 psig, CK-101 capacity 6.2 < 10") is withdrawn: it evaluated CK-101 at a ratio found by
assuming CK-102 passes 10 MMscf/d, which is not a feasible state. These are test anchors **only after** WP0 re-runs them with
the real `wtsWalk`; the audit ignored segment losses. WP0 writes the exact values into the fixture (`ANCHORS_CK2`: Pm,
ratio, regimes, `QmaxPair`, limiter, heater inlet T, duty) with a tolerance of 0.5 % and records them in the WP notes. Rule of
thumb to check: CK-101 stays critical while bean2 ≥ about 1.35 × bean1 (research §2.2; 32 × 1.35 ≈ 43).

**Dry-gas anchor** (cumulative cap, D10): Qo = Qw = 0 (`wJT = 1`), WHP 3,000, CK-101 32/64 at a rate it passes, CK-102 48/64
`inlet`. A single stage would be `jtOf(≈2,830) = 198 → 150` (capped). With CK-102 the stages are about 131 and
min(150 − 131, ≈68) = 19, so 150 in total. The heater inlet T and duty must equal the CK-101-only walk within the seg-3 loss
term (WP0 records the tolerance; expected ≤ 2 °F and ≤ 2 % duty).

---

## 5. Engine: CK-102 (WP-E1; section `// ─── CK-102 heater inlet choke (WP-E1) ───`)

### 5.1 Registries (WP-E0)
TAGS (l.110) `heaterChoke:'CK-102'`; NAMES (l.116) 'Heater inlet choke' (D17); RIG_* as §3.1; STEP_ORDER (l.196) after
'choke'; `NODE_IDS` append `'heaterChoke'` (index 10; l.207 "append only"); `HIST_KEYS` append `'Pck2'`, `'cushionLeft'`;
`Q_CK2 = ['CHOKE2_LIMIT','CK1_SUBCRIT','PAH_CK2','HYD_heaterChoke']`; `Q_SEPBY = ['PSHH_SEPBY','SEPBY_RATING']`;
`Q_CUSH = ['CUSH_LIMIT','CUSH_NOLIFT','CUSH_BURNER','CUSH_DUMP','HTR_FULL']`; `DEFAULTS.heaterChoke = {lagS:5,
designP_psig:1440, pahFrac:0.90}`; `features`.

### 5.2 `derive()` (l.582) and the block selection (WP-E0, lead-owned)
WP-E0 writes **`pickSteadyBlock()`**, the only place that chooses between the four steady cases (base / ck2 / sepBy /
sepBy+ck2). E1 and E2 consume its result and do not edit the selection lines:
```
pickSteadyBlock() → { kind:'base'|'ck2'|'sepBy'|'sepBy+ck2', chk, Pck_ss, Tck_ss, Ph_ss, Th_ss, Tin_ss, duty_ss,
                      SS2, SS3, ck2blk (flow.ck2 | flow.sepBy.ck2 | null), sepByBlk (flow.sepBy | null), P0 }
  sepByBlk = !rSep && isPlainObj(flow.sepBy) ? flow.sepBy : null
  ck2blk   = ck2Act ? (rSep ? flow.ck2 : (sepByBlk ? sepByBlk.ck2 : null)) : null;  ck2blk.skipped → treated as null + note
  base fields first (today's lines, unchanged); then sepByBlk overrides Pck/Tck/Ph/chk/SS2..SS4 from flow.sepBy;
  then ck2blk overrides Pck/Tck/Ph/Th/Tin/duty/chk/SS2/SS3 from the block:
    Pck_ss = blk.ck1.Pout; Tck_ss = blk.ck1.Tout; Ph_ss = blk.nodes.heater.P; Th_ss = blk.nodes.heater.T;
    Tin_ss = blk.Tout; duty_ss = blk.heater.dutyMMBtuHr;
    chk.regimeBase = chk.regime (kept from flow.choke / flow.sepBy.choke before the override);
    chk.regime = blk.ck1.regime; chk.QmaxMMscfd = blk.QmaxMMscfd; chk.flowLimited = blk.flowLimited; limFac = …(as l.597);
    SS2 = copy of blk.segs[0]; SS3 = copy of blk.segs[1]
```
E1's hook `ck2Derive(sel)` then fills the derived `CK2` object (reassigned on every `derive()`; it holds no lag state):
```
CK2 = { act, Pm_ss, Ph_ss, dPss, regime, bean, b1, pos, flowLimited, limiter, Tin, Tout, noFlow, designP, note }
  act = ck2Act && sel.ck2blk !== null;  else if (ck2Act) CK2.note = 'no heater-choke data in this flow (in line, ΔP 0)'
```
An E0 accessor `ck2Info()` → `{act, b1, b2: CK2.bean, dP: X.ck2dP}` is what E2 reads for the cushion liquid cap (§6.3). Everything
sits behind `ck2Act`, so the default spread runs the v3.3.1 lines untouched.

### 5.3 Live pressures and temperatures (hook `ck2Refresh(s)` in `refresh()` l.2025-2031; history via `pckLive()` l.1463)
```
Phi  = Pdn + (Phi_ss − Psep_ss)·fi²                                        (CK-102 outlet = H-101 inlet; Phi_ss from pickSteadyBlock)
PmT  = Math.max(Phi + (CK2.Pm_ss − Phi_ss)·fi², (CK2.Pm_ss + PSC)·fInst − PSC)
X.ck2dP += (PmT − Phi − X.ck2dP)·(1 − exp(−h / lagS))                      (5 s first-order lag; in substep, behind CK2.act || X.ck2dP ≠ 0)
Pm   = Phi + X.ck2dP                                                        (E0 stub ck2Pm)
Pck  = pckLive() = Pm + SS[2].dP·fi²                                       (CK-101 outlet, E0 stub ck2Pck; replaces Pdn + (Pck_ss − Psep_ss)·fi²)
N.heater.P = Pdn + (Ph_ss − Psep_ss)·fi²                                   (today's heater law, H-101 outlet: unchanged)
N.choke.dTjt       = 0.07·wJTe·(PB − Pck), capped at 150                   (unchanged form, CK-101 stage)
N.heaterChoke.dTjt = max(0, min(150 − N.choke.dTjt, 0.07·wJTe·X.ck2dP))    (cumulative cap, D10)
N.heaterChoke.Tin  = T at seg-3 outlet (≈ Tck, or Tp1 for midcoil from the CK2.Tin offset);  .T = .Tin − .dTjt
```
The lag is the CK-102 ΔP alone, measured from its outlet Phi (amended on `sim-fu-found`, Appendix B; revision 2 wrote the
heater law `Ph` here): the H-101 drop (about 5 psi) sits between Phi and Ph and is not in the lag, so its decay to 0 after
CK-102 leaves is continuous with today's law.
`wJTe` is `chk.wJT` except while the cushion flows (§6.3, an E2 value read through a hoisted local). When CK-102 leaves (or
`ck2Act` drops), the lag runs on with target 0. It is in the substep only while `X.ck2dP !== 0`, and snaps to exactly 0
below 1e-9 psi, so the default spread never enters it. Because `X.ck2dP` lives on `X`, a `derive()` caused by a bean2
change or any other host input (Thtr, heater bypass) during a transient keeps it (U2, U3).

### 5.4 Snapshot (always present; static values while out)
```
nodes.heaterChoke = { tag:'CK-102', inRig, active, bypassed, P (outlet), Pin (Pm), T, Tin, th, hyd, dTjt, regime, bean, pos,
                      flowLimited, limiter, QmaxMMscfd, designP_psig, note }   (out: P = Pin = choke outlet values, dTjt 0, regime '')
rigup.heaterChoke; inputs.bean2, inputs.ck2Pos (from the block, else null → NULLABLE)
```
`snap.segs` stays 6, and no new `lines` entry (`choke_heater` keeps its index). `NULLABLE` gains `inputs.bean2` and
`inputs.ck2Pos`, plus the copy in 32 (l.174).

### 5.5 Alarms (hook `ck2Alarms` in `designAlarms()`, evaluated only while `CK2.act`; released by `quiet(Q_CK2)` when it ends)
| Id | Level | Tag / eq | Raise / clear | Text |
|---|---|---|---|---|
| `CHOKE2_LIMIT` | alarm | CK-102 / heaterChoke | `CK2.flowLimited && CK2.limiter !== 'CK-101'`; clear at 1 % hysteresis | limiter CK-102: "CK-102 limits the rate: bean x/64 passes y of z MMscf/d — open CK-102 or reduce the rate"; limiter both: "CK-101 and CK-102 together pass y of z MMscf/d — open either choke or reduce the rate" |
| `CHOKE_LIMIT` (existing) | alarm | CK-101 | unchanged, **except** it is suppressed while `CHOKE2_LIMIT` is raised | as today |
| `CK1_SUBCRIT` | warning | CK-101 / choke | `CK2.act && chk.regime !== 'Critical' && chk.regimeBase === 'Critical'` (the base regime is kept in `chk.regimeBase` by `pickSteadyBlock`) | "CK-101 subcritical with CK-102 in line: in a real well the rate and WHP would now respond to the downstream pressure (not simulated)" |
| `PAH_CK2` | warning | PAH-102 / heaterChoke | live `Pm ≥ pahFrac·designP_psig`; clear 2 % below | inlet: "PAH-102: pressure between the chokes x psig, ≥ 90 % of the 1,440 psig design pressure of the line CK-101 → CK-102 — open CK-102"; midcoil: the same with "the line and H-101 pass 1" |
| `HYD_heaterChoke` | per the existing hydrate rule | CK-102 | judged on `N.heaterChoke.T` against `Thyd(Ph)`, like the desander (l.2003) | existing hydrate text with the tag |

All four ids go into the fixture `ALARM_IDS` and into exactly one quiet list ("every alarm id is in exactly one quiet list").
PAH-102 is raised from the live Pm, so a tester who pinches CK-102 from the HMI sees it, and the page's blocked-in warning
(§4.5) covers the static case.

### 5.6 API and events
`setRigup({heaterChoke:true})` works through RIG_KEYS. The bean is a host input: 38 `bean2` actions go through
`setHostInput('wts_bean2')` → `calcWTS` → `setFlow` → `derive()`, as `wts_bean` does (l.3599). No new engine API.

---

## 6. Engine: bypass destination and cushion (WP-E2; section `// ─── Bypass destination + cushion (WP-E2) ───`)

### 6.1 Configuration (`DEFAULTS`, deep-frozen; WP-E0)
```js
sep: { …, bypass: { dest: 'flare', P_psig: 150, P_flare_psig: 5, designP_psig: 1440, pshhFrac: 0.90 } },
cushion: { V_bbl: 50, SG: 1.03, q_bpd: 1500, tbgCap_bblft: 0.00870, depth_ft: 10000, Gr_psift: 0.08, gasFrac: 0.05,
           tailFrac: 0.15, tailTau_s: 1800, breakTau_s: 600, Cd_liq: 0.85, burnerSG: 0.95, stallMargin_psi: 50,
           unstallHyst_psi: 25, htrRatedFactor: 1.25,
           lim: { V: [1, 500], SG: [0.80, 1.50], q: [100, 6000], cap: [0.003, 0.03], depth: [500, 25000] } }
```
`burnerSG` only selects the `CUSH_BURNER` text (water / brine vs hydrocarbon). `P_flare_psig` equals the default
`sep.pcv.P2_psig` (asserted in wts-fu-identity), so the legacy path stays `===`. `flowDerived` (l.396) maps
`flow.sim.sepByDest` ('flare' | 'line', anything else 'flare') and `sepByP_psig` (`isFin`, clamp 0–1440) to
`cfg.sep.bypass`.

### 6.2 Bypass destination
- **`pDown()`** (l.964-968; hook `bypPDown()`), with `bypLine`, `bypP0`, `bypDP` hoisted in `derive()` from
  `pickSteadyBlock()`:
  ```
  if (rSep) return Psep (today);
  if (sepByBlk) return bypP0 + bypDP·(cushOn ? cushFm : fg)²;    bypP0 = flow.sepBy.P0_psig, bypDP = flow.sepBy.segs[2].dP
  return P_flare0 + SS[4].dP·fg²;                                (legacy; P_flare0 = cfg.sep.bypass.P_flare_psig, identical by default)
  ```
  With the block, P0 comes from the block, so the steady walk and the live back pressure share one P0; if a `setConfig`
  override makes `cfg.sep.bypass.P_flare_psig` differ from the block's P0 for 'flare', the block wins and `snap.sepBy.note`
  says so. `cushFm` (a closure double, written only by the cushion step) is the no-slip **mixture-rate** fraction while a
  cushion flows: `q_mix = 5.615·q_liq + q_gas·Bg5` (ft³/s at the seg-5 mean pressure and the steady line temperature; `Bg5`
  hoisted in `derive()` from `zFactor`), over the same expression at the steady rates. Without it the 1,500 bbl/d of brine
  would see 0.25 % of the steady line loss (fg ≈ 0.05). Seg 5 uses the flare-line geometry for both destinations, and the
  elevation of a burner boom or line riser is not modelled (ASSUMPTIONS, §1.2).
- **`derive()`**, only when `sepByBlk`: `Pck_ss / Tck_ss / Ph_ss / chk` come from `flow.sepBy` (or `flow.sepBy.ck2`) through
  `pickSteadyBlock()` (§5.2). The heater term `flow.sepBy.heater.dP` is left out while H-101 is out. The surge set point is
  `flow.sepBy.surgeP_psig` (§4.4) instead of `flow.sim.surgeP_psig`.
- **Accounting** (`substep()` l.1727-1728; hook `bypAccount(byG, byO, byW)`), behind `bypLine`: `byG → cum.lineGas`,
  `byO → cum.lineOil`, `byW → cum.lineWater` (today `cum.flare += byG`, `cum.ltfOil += byO`). Behind `ventOn` (V-101 and
  FS-401 out): the relief and vent gas of the vessels still in the rig-up (T-201 / T-202 PSVs and BPVs `qPsvU`, `qBpv`,
  `F2.*`, gauge-tank vents) goes to `cum.vent` instead of `cum.flare`. `massErr()` (l.779-788), `zeroCum`, `setRef` and
  `snap.cum` (`toLine_gas_mscf`, `toLine_oil_stb`, `toLine_water_bbl`, `toVent_gas_mscf`) are extended. History `qgFlare`
  already excludes byG.
- **`refresh()`** l.2037-2040 (hook `bypRefresh(s)`), on the `flow.sepBy` path only: `N.flare.Pline = pDown()` (the same
  expression; fixes the inconsistency). With `bypLine`: flame 0, `N.flare.label = 'production line'`. On the legacy path
  (V-101 out, no block) E0 shows `N.flare.P = N.flare.Pline = bypF0` (`P_flare_psig`, the inlet `pDown()` uses; equal to
  `S.pcv.P2_psig` by default, so v3.3.1 exactly), not `S.pcv.P2_psig`. Flare-node and history gas: hooks `bypFlareQ(qFl)`
  (refresh, behind `bypLine`: byG goes to the line, and with `ventOn` the relief / vent gas goes to vent) and
  `bypVentHist(q)` (`histSample`, behind `ventOn`: `qgFlare` without the relief gas to vent) — WP-E2 fills both.
- **Protection** (D16; hook `bypAlarms`, behind `!rSep`):
  - `PSHH_SEPBY` (alarm, PSHH-104 on the bypass path): the live pressure at the H-101 outlet / seg-4 inlet (`Ph`) ≥
    `pshhFrac·designP_psig` → trips SDV-101 through the same path as `DES_PSHH` (PSHH-103). Text: "PSHH-104: bypass path
    x psig ≥ 90 % of its 1,440 psig design pressure — SDV-101 tripped".
  - `SEPBY_RATING` (warning, static): `bypP0 + bypDP > designP_psig` for 'line': "Production line x psig plus line loss y
    psi above the bypass-path design pressure; a blocked outlet is not simulated".
- `snap.sepBy = {dest, P_psig, P0_psig, active: !rSep, vent: ventOn, note}`. **Shut-in** (`PBt = pDown()`, l.1765): with
  'line', after SDV-101 closes the spread between SDV-101 and NRV-501 is held at line pressure (NRV-501 stops backflow from
  the line; the snapshot note says "held at line pressure by NRV-501: close XV-501 to isolate"). PSHH-104 then guards it if
  the line pressure is above the bypass-path rating. The separator PSV / PSHH stay live on a blocked-in V-101 (unchanged).
- `RIG_TXT.separator` gets a destination variant: 'flare' keeps the v3.3.1 text "bypassed (well stream to the flare /
  burner)" (so the log and `'rigup'` event text of a mid-run `setRigup` stay v3.3.1 exactly, wts-fu-identity (1); amended on
  `sim-fu-found`), 'line' is "bypassed (well stream to the production line at P psig through NRV-501 / XV-501)", including
  the normRigup notes (l.177).

### 6.3 Cushion unload
**State**: a closure variable `cushS` (not on `X`, never touched by `derive()`) and a closure boolean `cushOn`:
```
cushS = { phase:'off'|'unloading'|'stalled'|'breakthrough'|'tail'|'done', V, SG, qSet, cap, depth, Gr, gasFrac, tailFrac,
          tailTau, breakTau, Vmain (= V·(1 − tailFrac)), Vtail, Vprod (bbl, delivered), qNow (bbl/d, target), qDel (bbl/s,
          delivered cushion water, its own lag state), fUnload, WHPcol, wJTc, tStart, tBreak (null until), tPhase,
          out:{flare, line, sep} }
```
Derive-time constants for the cushion (computed in `derive()` only when `cushOn`, or by `startCushion`): `SIT = DD.sit`
(entered SITHP) or `Rr.sithpFactor·Pwh_ss`; `Bgwh = 0.00504·Z·TR/Pa` rb/scf at the steady wellhead (`zFactor`); the
reservoir-volume rate equivalent of the steady flow `qRes_ss = Qg_scfd·Bgwh + Qo + Qw` (rb/d; Bo ≈ 1, ASSUMPTION).

**Per substep** (hook `cushStep(h)`, behind `cushOn`; in the rate-target block l.1745-1750, after the DS-101 coupling factor
`DX.s`). Units: the engine's rate targets are **bbl/s** (STB/s) as in `derive()` l.591 (`qwD = Qw/86400`), and cumulative
volumes are bbl ("base units: scf, STB, bbl", l.1726); ft³ appear only in the velocity and mixture terms.
```
hc      = Math.min(Math.max(0, Vmain − Vprod), depth·cap) / cap                  (column of the main slug, ft; 0 after breakthrough)
fUnload = Math.min(1, (gasFrac·Qg_scfd·Bgwh + qPrev) / qRes_ss)                   (qPrev = qNow of the previous substep; qSet at start)
WHPcol  = SIT − (SIT − Pwh_ss)·fUnload − (0.433·SG − Gr)·hc                     (ASSUMPTION: straight-line deliverability in WHP)
floor   = pDown() + stallMargin
stall   : unloading → stalled when WHPcol ≤ floor; stalled → unloading when WHPcol > floor + unstallHyst
ΔPch    = ck2Info().act ? X.PB − Ph − SS[2].dP·fi² : X.PB − Pck                  (whole drop across the choke(s))
d_eq    = (ck2Info().act ? Math.pow(Math.pow(b1,-4) + Math.pow(b2,-4), -0.25) : b1) / 64          (in)
qLcap   = 1023·Cd_liq·d_eq²·√(Math.max(0, ΔPch)/SG)                                               (bbl/d; liquid never chokes)
qNow    = stalled ? 0 : Math.min(qSet, qLcap)             → CUSH_LIMIT while qLcap < 0.99·qSet (clear at qSet)
```
**Targets** (bbl/s for liquids, the engine's gas basis for gas):
```
unloading:  cushion water qcT = qNow/86400;  gas = gasFrac·qgE;  formation oil = formation water = 0
stalled:    all well rates 0 (well dead): qcT = gas = oil = water = 0
after tBreak (breakthrough, tail, done): w = 1 − exp(−(t − tBreak)/breakTau)
            formation streams only: gas = (gasFrac + w·(1 − gasFrac))·qgE;  oil = w·qoE;  formation water = w·qwE
            cushion water = the tail only:  qcT = (Vtail/tailTau)·exp(−(t − tBreak)/tailTau)
            Vtail = V − Vprod(tBreak) − Rr.tauFlow·qDel(tBreak)        (the lag's in-flight volume, so ∫qDel dt = V exactly)
cushion delivered:  qDel += (qcT − qDel)·(1 − exp(−h/Rr.tauFlow));   Vprod += qDel·h;   routed to out.flare | out.line | out.sep
                    by the destination at that instant; qDel is added to the delivered water that enters V-101 / the line
                    and to cum.waterIn, and massErr uses the delivered rates
```
There is no cushion term in the blend: all cushion water after breakthrough is the volume-balanced tail, so the cushion
integral is V and nothing is counted twice (the blend's cushion part would otherwise add qNow·breakTau ≈ 10.4 bbl).

**Phase rule**: `unloading` / `stalled` until Vprod reaches Vmain (breakthrough, located in `chooseH`); `breakthrough` while
w < 0.95 (t − tBreak < breakTau·ln 20 ≈ 1,800 s at the defaults); then `tail`; `done` (takes precedence) when
Vprod ≥ V·(1 − 1e-3), with a backstop at t − tBreak ≥ 10·tailTau. After `done` the cushion water target is 0 and the
formation blend runs on; once w > 1 − 1e-9 `cushOn` goes false (`quiet(Q_CUSH)`), and `cushS` stays readable until Reset /
stop. A `'cushion'` event fires on start, stall, un-stall, breakthrough, tail and done; log `event` / `CUSHION`.

**WHP target** (replaces tgtW l.1758-1759 while `cushOn`; shut-in branch l.1761-1763 unchanged):
```
unloading:   tgtW = Math.max(floor, WHPcol)·(1 + noise)                          (noise = today's N.whpSigma·X.xiW term)
stalled:     tgtW = Math.max(pDown(), SIT − (0.433·SG − Gr)·hc)                  (static WHP of a dead well; no noise applied;
                                                                                   the PRNG draws continue unchanged)
after tBreak: X.tFlow is reset to 0 at tBreak, so the drawdown term starts with the formation flow;
             tgtW = (1 − w)·Math.max(floor, WHPcol)·(1 + noise) + w·tgtNormal    (tgtNormal = today's law l.1758)
```
So the end of the cushion does not step WHP.

- **Breakthrough exactly**: in `chooseH()` (hook `cushChooseH(c)`; the gated optional-items block l.1869), while unloading,
  with R = Vmain − Vprod, q0 = qDel and qT = qcT, the delivered volume over s is
  `V(s) = qT·s + (q0 − qT)·τf·(1 − e^{−s/τf})` (τf = Rr.tauFlow). `te` = the linear estimate R/q0, then one Newton step on
  V(s) − R. The substep is cut at te, so the event lands within one substep and dt 1 / dt 10 agree on tBreak (U5, §10).
- **J-T weight while the cushion flows (D8)**: the gas share of the heat capacity of the unload stream,
  `wJTc = (mdG·0.56)/(mdG·0.56 + mdL·cpL)` with `mdG = gasFrac·Qg_scfs·rhoGstd` (lb/s), `mdL = 14.6/3600·SG·qNow` (lb/s;
  14.6 lb/h per bbl/d of water) and `cpL` 1.0 Btu/lb·°F for water / brine (SG ≥ burnerSG), 0.5 for a hydrocarbon cushion.
  `wJTe = (1 − w)·wJTc + w·chk.wJT` (w = 0 before breakthrough), used for `N.choke.dTjt` and `N.heaterChoke.dTjt`. At the
  defaults wJTc ≈ 0.161/(0.161 + 6.27) ≈ 0.025, so a 1,500 psi choke drop cools about 2.6 °F instead of about 59 °F.
- **Flow fraction (D8)**: warm-up threshold `thT = (X.f > 0.05 || (cushOn && cushS.qNow > 0)) ? 1 : 0`. Segment velocity
  `vel_i = ss.vel_i·fInst + qDel·5.615/A_i` (ft/s; A from the line `ID_in`; qDel in bbl/s).
- **Heater duty (D8)**: additive, `duty = duty_ss·X.f + dutyL`, `dutyL = 3600·mdL·cpL·(Th − TinL)/1e6` MMBtu/h. Capped at
  `dutyMax = htrRatedFactor·duty_ss` (ASSUMPTION; H-101 has no rating input). When the cap binds, the heater outlet is
  `Tin + dutyMax·1e6/mcpTot` (`mcpTot = X.f·mcp_ss + 3600·mdL·cpL`, Btu/h·°F; WP-E2 checks the time basis of the existing
  heat-capacity rate and converts the liquid term to it) and `HTR_FULL` (warning) says "H-101 at full firing: outlet x °F,
  set point y °F". With the heater bypassed or out there is no duty and no cap. Hook sites (E0, `sim-fu-found`):
  `cushHeater(N.heater)` in `refresh()` right after the `N.heater` duty / T lines and before `hydOf(N.heater)` (sets
  `dutyMMBtuHr`, the capped `T`), and `cushTsep(T)` in `algebraic()` where `X.Tsep` is formed, so the capped outlet reaches
  V-101 (and through `X.Tsep` the surge / gauge temperatures); both behind `cushOn`.
- **Separator (V-101 in)**: `Cv_w` **stays as sized** in `derive()` (l.652; `dumpFactor 4 × max(qwE, 100 bbl/d)`, i.e.
  800 bbl/d at the defaults). `startCushion` compares q_set with the dump capacity at the design ΔP and, when it is
  exceeded, returns `{ok:true, warn:'V-101 water dump passes x bbl/d: reduce the unload rate or route to the line'}`;
  `CUSH_DUMP` (warning) is raised while the cushion rate exceeds it, and LAH / LSHH act as on a real spread. The dump and
  WGRAD use `SG` while the cushion is on (mixing ignored, stated). No hardware changes during a run.
- **Gauge tank batches** recorded while the cushion flows are tagged `cushion:true` (100 % BS&W). Hook site (E0,
  `sim-fu-found`): `cushBatch(b, w)` in `recordBatch`, behind `cushHas`, after the batch record `b` is built from its window
  `w` and before it is stored, emitted (`'batch'`) and logged; E2 tags it when `w` overlaps the cushion.
- **Burner caution**: `CUSH_BURNER` (warning) for **any** cushion liquid to the burner / flare line with V-101 out
  (`!rSep && dest 'flare' && qDel > 0`). Text by SG: SG ≥ burnerSG "Water / brine cushion to the burner: flame-out and
  fallout — put V-101 in (liquids to the tanks) or route to a production line"; SG < burnerSG "Oil / diesel cushion to the
  burner: liquid fallout and burning liquid without an atomising burner (not modelled) — put V-101 in or route to a
  production line".
- **Hydrates at breakthrough**: no special code. The ramp of `X.f` and of `wJTe` with a cold heater gives the existing
  hydrate alarms (the course point: the heater must be warm before breakthrough).
- **API**: `startCushion(o)` (`o` clamped by `lim`, returns `{ok, msg, warn}`; refused while the ESD is tripped and while a
  cushion is running); `stopCushion()`; `getCushion()`. `reset()` → `initState` clears it.
- **Snapshot**: `snap.cushion = {on, phase, V_bbl, SG, q_set_bpd, q_bpd, qcap_bpd, WHPtgt_psig, column_ft, Vleft_bbl,
  recovered_bbl, fUnload, wJT, dutyCapped, tBreak, out:{flare, line, sep}}`. It is always present; while off it holds
  zeros and `phase 'off'`. `NULLABLE` gains `cushion.tBreak`.
- **History**: `Pck2` and `cushionLeft` are plain number writes into their preallocated arrays on every sample (`Pck2` =
  Pm while `CK2.act`, else the CK-101 outlet; `cushionLeft` = V − Vprod while a cushion exists, else 0), with no object
  access when the features are off; they are inside the default-spread perf gate (§10).

### 6.4 Worked numbers (defaults D7, WHP 3,000 psig, Qg 10 MMscf/d, Qo 1,000, Qw 200; WP0 re-anchors with the engine)
- Main slug column = 42.5 bbl / 0.00870 = 4,885 ft (the tail volume is not in the column). Net head =
  (0.446 − 0.08)·4,885 ≈ 1,788 psi.
- SIT = 1.2 × 3,000 = 3,600 psig (no SITHP entered). Bgwh ≈ 0.00504·0.85·640/3,015 ≈ 0.00091 rb/scf, qRes_ss ≈ 9,100 +
  1,000 + 200 ≈ 10,300 rb/d; unload qRes ≈ 0.05·9,100 + 1,500 ≈ 1,955 rb/d, so fUnload ≈ 0.19.
- WHP target at the start ≈ 3,600 − 0.19·600 − 1,788 ≈ 1,700 psig, rising to about 3,490 psig at the end of the main slug,
  then blending to the flowing law (3,000) as the formation comes in.
- Liquid cap on 32/64 (Cd 0.85) at ΔP ≈ 1,550 psi: 1,023·0.85·0.25·√(1,550/1.03) ≈ 8,400 bbl/d, so it does not limit
  1,500 bbl/d. On 12/64 (d 0.1875″) at the same ΔP: about 1,190 bbl/d, so `CUSH_LIMIT` fires.
- Water accounting: 1,500 bbl/d = 0.01736 bbl/s, so `cum.waterIn` after 1 h of unloading is 62.5 bbl (less the lag's
  in-flight 0.35 bbl).
- Breakthrough at 42.5 / 1,500 × 24 = 0.68 h. Vtail ≈ 7.5 − 0.35 = 7.15 bbl; the tail is 95 % recovered by 3τ = 1.5 h after
  breakthrough and `done` comes at about tBreak + 5τ ≈ 3.2 h.
- J-T at the start: wJTc ≈ 0.025, so the 1,300-1,550 psi drop across CK-101 cools about 2-3 °F (no hydrate alarms with a warm
  wellhead stream).
- With V-101 in at the defaults the water dump passes about 800 bbl/d, so `startCushion` warns and V-101 floods to LAH /
  LSHH within minutes: the FS-1 lesson for unloading through the separator.
- `CUSH_NOLIFT` case: 150 bbl in 2-7/8″ (0.00579 bbl/ft) to 25,000 ft: column min(127.5/0.00579, 25,000) = 22,021 ft, net
  head ≈ 8,060 psi > SIT, so the well stalls at once.

---

## 7. Interfaces (exact; frozen in `tests/_wts-fu-shapes.js` by WP0)

### 7.1 Exports (`WTS_sim`)
Changed: `VERSION '1.5.0'`, `RIG_KEYS` / `RIGUP` (11), `RIG_DEFAULTS`, `RIG_OPTIONAL` (3), `TAGS`, `NAMES`, `NULLABLE`,
`DEFAULTS` (`sep.bypass`, `cushion`, `heaterChoke`), `SAMPLE_FLOW.sim` (+2; `SAMPLE_FLOW` has **no** `ck2` / `sepBy`
block), `HIST_KEYS` (+2), `NODE_IDS` (11). New: `features`, `normRigup(req, o)` signature (exported as today if it is
exported; pure).

### 7.2 Instance API
| Call | Returns | Notes |
|---|---|---|
| `setRigup({heaterChoke})` | bool | as for other optional items |
| `getRigup()` | 11 booleans | |
| `setConfig({sep:{bypass:{dest, P_psig, P_flare_psig, designP_psig}}})` | as today | re-normalises the rig-up through `rigRenorm` (§3.3) |
| `setFlow(flow)` with a changed `flow.sim.sepByDest` | as today | `applyFlow` runs `rigRenorm` before `derive()` (§3.3) |
| `startCushion(o)` / `stopCushion()` / `getCushion()` | `{ok, msg, warn}` / bool / snapshot copy | §6.3 |

### 7.3 Contract fixture (WP0)
`tests/_wts-fu-shapes.js` exports, frozen:
- the RIG_ITEMS row, `RIG_DEFAULTS`, the 11-character `SIG_DEFAULT`, the `stepFor` combinations, `COUNT_SITES` (§3.6);
- `LABELS` (D17): the one label per item for WP-C, WP-L and WP-HC;
- the alarm ids and quiet lists, `HIST_KEYS` additions, the `flow.ck2` / `flow.sepBy` shapes with the `ANCHORS_CK2` values
  (incl. `QmaxPair`, limiter, the dry-gas anchor) and `ANCHORS_CUSH` (tBreak, start WHP, fUnload, recovered);
- `BASE_FIELDS`: the golden's base-field rule (all of `flow` minus `ts`, `seq`, `ck2`, `sepBy`, `sim.sepByDest`,
  `sim.sepByP_psig`), §9.2;
- the `snap.cushion`, `snap.sepBy` and `nodes.heaterChoke` shapes;
- a `fakeFuSnapshot(base, {ck2, bypassed, dest, cushion})` helper for the view builders;
- the 3D → 38 action payloads `{type:'bean', eq:'heaterChoke', d:±4}` and `{type:'cushion', cmd:'start'|'stop'}`.

The real snapshot is checked against it in `wts-heater-choke` and `wts-bypass-cushion`.

---

## 8. Views

### 8.0 Rule
As v3.3.1 D18: CK-102 out means hidden in every view table (no ghost, picking, framing, label or tracer). The bypassed state
(in the rig-up, heater bypassed or H-101 out) is drawn **greyed with the label "bypassed"**, because it is a line-up and not
an absence. The destination and the cushion are labels and colours only.

### 8.1 3D (`32-wts-3d.js`, WP-3D)
- **Tables**: EQ_IDS l.57; OPT l.58 (`heaterChoke:true`); STEP l.59 / STEP_ORDER l.61; TAGS / TITLES / PREF_SIDE l.62-67;
  ANCHORS l.70 `[-3.55, 2.6, 0.4]`; PROXIES l.107 `['heaterChoke',[-3.55,2.0,0.4],[0.5,0.8,0.5]]` (the heater proxy spans
  x −3.1…0.3, so no overlap); EQ_BOX / FOCUS / HALO l.136-159; RIG_GROUPS l.263; NODE_NAMES l.678 + fallback l.679;
  `fakeSnapshot` nodes / rigup / sig l.925-1001; NULLABLE copy l.174.
- **Geometry**:
  - The heater inlet leg E3c (l.212) runs from the tee (−4.3,1.2,0) to (−3.9,1.2,0), up the riser past the inlet gate valve at
    (−3.9,1.55,0) (l.1940), to (−3.9,1.9,0), then to (−3.9,1.9,0.4) and on to the coil inlet (−3.15,1.9,0.4).
  - CK-102 is a copy of the CK-101 block (l.1831-1843: angle body, bonnet, handwheel) at 0.8 scale, placed on the last
    horizontal stub at x ≈ −3.45 (as built: −3.55 moved by the clearance model to keep the riser and the H-101 end ring clear), y 1.9, z 0.4, clear of the shell end ring at x −3.1. A small PAH-102 label sits on the
    stub between the chokes.
  - E3c splits into E3c1 / CK-102 / E3c2 with `rig:'heaterChoke'`, like D1/D2 (l.233-234). Add the NEW_ROUTES entry
    (l.248) and the NOZZLES entries for the endpoint check. While CK-102 is out, E3c is drawn as in v3.3.1.
- **Rebuild key**: 32 rebuilds the scene only when `rigSigOf(RIG_GROUPS)` changes (l.726, 4318, 4369). The key becomes
  `rigSig + (rig.separator === false ? '|' + snap.sepBy.dest : '')`, so a destination change with V-101 out rebuilds the
  bypass spool; with V-101 in the key (and the scene) is the v3.3.1 one. The CK-102 **bypassed** grey state is a per-frame
  material state (like frost), not geometry, so a heater-bypass toggle never rebuilds. Adding `heaterChoke` to `RIG_GROUPS`
  makes the 3D `rigSig` 9 characters: the literals in the 32 self-tests (l.4629, l.4674-4675) and wts3d-test (l.584, 587,
  599) move with it (§3.6).
- **Dynamics**: `S.dyn.heaterChoke = {wheel, ang}` turns with `bean2`. Frost on the downstream body when
  `nodes.heaterChoke.hyd`. Greyed while bypassed.
- **midcoil (C)**: the body moves to a crossover loop above the shell end (WP-3D picks the location, and the clearance test
  covers it). If time is short, the inlet body stays with the label "between passes". **As built (WP-3D): the fallback** — the body stays on the inlet stub and the chip title reads "HEATER CHOKE (BETWEEN PASSES)".
- **Bypass destination 'line'**: the separator bypass spool (`BYPASS_SPOOLS.separator` l.257) is routed to the export spool
  (`BYPASS_SPOOLS.flare` l.260), with labels PSHH-104 on the bypass spool and NRV-501 / XV-501 at the tie-in, and the
  flame stays off. With 'flare' the scene is unchanged (PSHH-104 label only while V-101 is out).
- **Cushion**: no geometry. The stream colour is already per phase (water while unloading).
- Framing gate: the four combinations (none, CK-102, CK-102 + DS-101, CK-102 bypassed) at two sizes, plus V-101 out with
  'line'.

### 8.2 2D schematic (host `wtsDrawDiag`, WP-2D)
- **The static page diagram stays at v3.3.1.** It is called as `wtsDrawDiag(nodes, segs)` with the 8 calc nodes and no
  options (host l.129624, 38 `drawStatic2d` l.71516); it never draws CK-102, so the Help page checks and the divert-glyph
  tests are unaffected and WP-2D does not depend on WP-C. Only the **live** 2D (38 `liveNodes`, 11 nodes) draws CK-102,
  from `liveNodes[10]`, when called with `opts.ru.heaterChoke === true && opts.ru.heater !== false` and 11 nodes.
- `WTS_DIAG_LAYOUT` (l.129722) gains `ck2:{x:470, cl:10}` in both variants (base: choke 380 / heater 535; DS: choke 400 /
  heater 535). Labels: "CK-102" at cy−48, regime at cy−34, bean at cy+78, P/T at cy+50/63. They fit between 380±25 and
  535±25.
- `wtsDrawDiag` (l.~129750), live call only: split pipe i=2 at `ck2.x` like the DS split of i=1, and draw a small choke
  with a new `wtsEqChkS(ctx, x, y, regime, limited, sc)` that wraps `ctx.save / translate / scale` around the existing
  `wtsEqChk`. `wtsEqChk` itself is **not changed**, so its `wts-host-patch.js` done marker
  (`function wtsEqChk(ctx,x,y,regime,limited){`) and all existing calls stay byte-identical.
- While CK-102 is out (or the static call), the v3.3.1 row is drawn exactly (divert glyph tests unchanged).
- As built (WP-2D review): with CK-102 in, its hydrate flag replaces the bean label (cy + 90 would run into the strip), and seg 3
  carries no phase label (the CK-101 and CK-102 regime texts at cy − 34 leave no room); with V-101 out to the production line and
  a seg-3 hydrate mark the destination label starts at tx[4] + 60.
- Labels by destination: `BYPASSED → BURNER LINE` / `BYPASSED → PRODUCTION LINE (P psig) · NRV-501 / XV-501` (38 l.3117),
  and `GAS → EXPORT LINE` (l.3121) stays.

### 8.3 Live controller and HMI (`38-wts-live.js`; WP-E0 foundation, then WP-L; 2D overlay functions WP-2D)
- **Foundation (E0)**: EQ_IDS l.48; STEP fallback l.50; TAG / NAME / EQ_ABBR l.52-58; HOST_NM / NODE_KEYS l.60-61 (index 10;
  `liveNodes` l.222 emits 11); RIG_FALLBACK l.80; `INPUT_FOR` l.89 `heaterChoke:'wts_bean2'`; rig persistence §3.4; the
  `rigup` handler calls `window.wtsRenderResults(WTS_lastCalc.flow, rig)` (guarded, display only, **never** `calcWTS`);
  `readPrefs` / `writePrefs` `cushion` block; `inputsDiff` entries (§3.4).
- **CK-102 card (L)**, modelled on `case 'choke'` (l.2177):
  - rows: Upstream P (Pm), Downstream P, Regime, Bean, Position, ΔP, J-T ΔT, Outlet T, Hydrate T / margin, Pair capacity,
    Limiter, Design P (PAH-102);
  - spark `['Pck2']`; actions `bean2` (−4/+4, clamp 4–128).
  - `renderCardActions` `a === 'bean'` (l.2422) and the click handler `case 'bean'` (l.3599) get a `bean2` branch on
    `wts_bean2`.
  - The card says "Bypassed with H-101" while bypassed.
- **Heater card** (l.2190): a "Heater choke" row while CK-102 is in. The bypass action's confirm text adds "CK-102 goes out
  of line with it".
- **Rig card**: the CK-102 row shows "Bypassed with H-101" when that applies. The V-101 row note follows the destination,
  and the FS-401 switch is enabled with V-101 out only for 'line' (note: "relief of the tanks goes to vent").
- **Scenarios menu** (built from `faultList()` l.3395): after the existing entries comes "Cushion unload (clean-up)", which
  opens a form (volume, SG, unload rate, tubing size select 2-3/8 / 2-7/8 / 3-1/2 / 4-1/2 → capacity, depth). Its buttons
  are Start and Stop, and the form is a modal `<dialog>` `.rp-skip` `data-rp-nosnap`, like `WTS_cheminjInfo`. Its control
  ids share the prefix `wtsl_cush_` (one `notDocumented` pattern in WP-HC). The `startCushion` `warn` text (dump capacity)
  is shown in the form. The form values persist in `h2viz3d_prefs.cushion`.
- **HUD**: "Cushion: phase · recovered x / V bbl · q bbl/d", plus the totals line "To production line" while `bypLine`
  and "To vent" while `ventOn`.
- **Flare card**: label "Production line" and P while `bypLine`; flame 0.
- **2D overlay (WP-2D)**: `draw2dLive` l.2830, `drawRig2d` l.3048, `zones2d` l.3244 (zone at `ck2.x`), `valves2d` l.3226.
  The `off('heater')` mask (l.3113) also masks CK-102 (as built: not needed — `normRigup` takes CK-102 out with H-101, and the
  host draws CK-102 only with H-101 in; the unreachable mask was removed in the WP-2D review).
- **Phone / iOS**: the cushion form follows the `.cj-dlg-ov` safe-area rule in `ios-additions/ios-styles.css` (one rule,
  owned by WP-L, in its own commented block placed **after** the Help release's rules; as merged: section 9, after the Help
  centre's section 8, closed by "end of section 9"). Inputs ≥ 16 px.

### 8.4 Reports and project files
- The CK-102 rbox and the Rig-up row are captured for free (`.rbox`, `.rrow`). Rows of an item that is out are `rp-skip`, so
  the default page report keeps the v3.3.1 rows plus the two new Dynamic Simulation inputs (`wts_sepByDest`, and
  `wts_sepByP` only while 'line').
- Project files carry `wts_page_wts` (the four inputs) and `wts_sim_rigup` (11 keys).

---

## 9. Tests

### 9.1 Existing tests that change
- The counts of §3.6 (from the grep rule, recorded in `COUNT_SITES`).
- `wts-equipment.test.js`: `SAMPLE_FLOW_SIM` keys 7 → 9; `ALARM_IDS` and the quiet-list test gain the eleven ids of D12 (Appendix B, Counts)
  (three new quiet lists); FAULT_IDS stays at 16.
- `wts3d-test.js`: node count 11, RIGUP 11, 3D rigSig 9, and the host flow check l.791 ("patched calcWTS publishes flow
  v1 = `WTS_sim.SAMPLE_FLOW`", strict key-set `eqShape` l.643-647): **named allowance "fu-blocks"** (permanent, not
  interim): the check strips `ck2` and `sepBy` from the host flow before `eqShape`, because `SAMPLE_FLOW` deliberately has
  neither (D3). The `flow.sim` key list matches once both sides have the two new keys (an interim allowance only between
  WP-E0 and WP-C, marked "interim allowance", removed as a WP-C exit item). The `wts-host-patch.js --check` run (l.782)
  stays green (§4.1).
- `31` self-tests 13 / 26 / 14: lines and history names (+2 history), the exports line l.4256.

### 9.2 New tests and tools
| File | Owner | Content |
|---|---|---|
| `tests/_wts-sim-v331.js` | WP0 | frozen copy of 31 at `3611343`, self-test stripped (same tool as `_wts-sim-v33.js`) |
| `tests/_wts-calc-v331.js` | WP0 | golden `calcWTS` output for 12 input sets, **all written as literals in `wts-calc-golden.js`**: defaults; the five FS-1 page cases (a)–(e) and the FS-2 case copied from the Help branch as plain input objects (no import from the unmerged branch); WHP 500 / 60 / 2,000; bean 16 and 64; heater bypass. Generated by `prism-build/wts-calc-golden.js --write` on the unchanged tree, in a stub harness with `wts_sim_rigup` and `wts_page_wts` cleared before each set |
| `tests/_wts-calc-v331-src.js` | WP0 | the v3.3.1 `calcWTS` function text (and its helpers), frozen from the host at `3611343`; the timing baseline of §10 |
| `tests/_wts-fu-shapes.js` | WP0 | §7.3 |
| `tests/wts-fu-identity.test.js` | WP0 / lead | **(1)** frozen v3.3.1 vs working engine, every v3.3.1 snapshot path `===`, sig `slice(0,10)` equal and `slice(10) === '0'`, on scenarios a–e plus (b) one per core item out, plus DS-101 in with flow-back, T-202 in with route 'both', and both in — **on `SAMPLE_FLOW` and on a harness-`calcWTS` default flow** (blocks present, V-101 in, CK-102 out) fed to both engines. **(2)** v3.3 identity tests unchanged. **(3)** host golden: the base fields (`BASE_FIELDS`: all of `flow` minus `ts`, `seq`, `ck2`, `sepBy`, `sim.sepByDest`, `sim.sepByP_psig`; this includes `flow.warnings`, `flow.nodes`, `flow.segs`, `flow.choke`, `flow.heater`, `flow.sim.surgeP_psig`) for the 12 sets are strict `===` to the golden, with and without CK-102 / destination inputs set and with `wts_sim_rigup` holding a CK-102 / V-101-out rig-up (the rig-up must not move the base). **(4)** `DEFAULTS.sep.bypass.P_flare_psig === DEFAULTS.sep.pcv.P2_psig`; `features` keys all equal |
| `tests/wts-heater-choke.test.js` | WP-C (host part), WP-E1 (engine part) | normRigup (needs heater, strict-true, sig 11, extras); `flow.ck2` at bean2 48 = `ANCHORS_CK2` (Pm, CK-101 critical); bean2 32 → flow-limited, limiter `'CK-102'`, `QmaxPair` = anchor; both chokes subcritical at the pair capacity gives limiter `'both'` — at a separator pressure of 1,500 psig (32/64 + 40/64, and equal beans 32/32); at 150 psig equal beans give `'CK-102'` (Appendix B); bean2 4 → `No Flow`, no throw; liquid-only flow (Qg 0) → `skipped` block with note; **dry-gas anchor**: heater inlet T and duty with CK-102 48/64 inlet equal the CK-101-only walk within the recorded seg-3 tolerance; position midcoil: same pressures and duty, CK-102 outlet T differs by the pass-1 heat, Tp1 ≤ Tho − 25; blocked-in warning text by position at SITHP 3,600; engine with `flow.ck2`: choke outlet = Pm + seg-3 loss; `HYD_heaterChoke`, `CHOKE2_LIMIT` (and `CHOKE_LIMIT` suppressed), `CK1_SUBCRIT` only when the base was critical; `PAH_CK2` raised on a live bean2 pinch to 4/64 at high WHP (U7); heater bypass → inactive and continuous (no step > 1 psi in 1 s); rig in / out continuity through the lag; **derive-survival**: change bean2, then the Thtr input, during a CK-102 transient — `X.ck2dP` kept and no step; cumulative J-T cap in the engine (`N.choke.dTjt + N.heaterChoke.dTjt ≤ 150`); determinism (same seed → same state); dt 1 vs dt 10 within the self-test-6 tolerances; old flow without `flow.ck2` → note, no throw; `calcWTS` never reads `wts_sim_rigup` (storage spy) |
| `tests/wts-bypass-cushion.test.js` | WP-C (host part), WP-E2 (engine part) | HELP-GUIDE-PLAN §8.3 as corrected: `pDown` per destination (legacy on `SAMPLE_FLOW`, multiphase with `flow.sepBy`, P0 from the block); `calcWTS` sepBy choke outlet follows the destination, not Psep; `wts_sepByP` 0 is kept (not 150); destination ≥ choke inlet → No Flow warning; normRigup allows V-101 + FS-401 out only for 'line', and line → flare re-forces the flare **through `setConfig` and through `setFlow`** (page path); no flare totals with 'line'; vent sink with FS-401 out; mass balance `massErr` < 1e-6 per destination, with the vent and with the cushion; `PSHH_SEPBY` trips SDV-101 with line P 1,400 psig; `SEPBY_RATING`; shut-in with 'line' holds line pressure with the NRV note; **cushion units**: gasFrac 0, 1,500 bbl/d, `cum.waterIn` after 1 h = 62.5 bbl within 1 %; breakthrough at Vmain delivered to one substep, dt 1 vs dt 10 agree on tBreak; **∫cushion water dt = V within 0.1 % at tBreak + 10·tailTau** (separately from `done`), and `done` reached after tBreak + about 5·tailTau (± 10 %); phase sequence unloading → breakthrough → tail → done; WHP monotonic while unloading and start WHP = `ANCHORS_CUSH` (SIT-based law); no WHP step > 50 psi at breakthrough; `CUSH_LIMIT` at 12/64; qLcap with CK-102 128/64 within 1 % of CK-101 alone; `CUSH_NOLIFT` with 150 bbl in 2-7/8″ to 25,000 ft, all well rates 0 while stalled; `CUSH_BURNER` with dest flare at SG 1.03 (water text) and at SG 0.85 (hydrocarbon text); J-T: no `HYD_*` during unloading with a warm heater, the existing hydrate alarms at breakthrough with a cold heater; warm-up runs during the unload; duty additive, `HTR_FULL` with q 3,000 bbl/d from a 60 °F wellhead and the outlet below the set point; `CUSH_DUMP` and LAH with V-101 in at the defaults, `Cv_w` unchanged before / during / after; **derive-survival**: change Thtr and bean2 during an unload — cushion state and `Cv_w` kept; Reset clears; determinism |
| `tests/wts-fu-views.test.js` | WP-L, WP-2D, WP-3D (groups), lead merges | 2D: CK-102 glyph only on the live call while in, static diagram byte-identical, legacy row byte-identical when out, destination labels; HMI: card rows, bean2 action → `setHostInput('wts_bean2')`, Scenarios entry and form (ids `wtsl_cush_*`), prefs round trip and sanitiser, `inputsDiff` entries, HUD line, rig-card notes, the `rigup` handler calls `wtsRenderResults` and not `calcWTS` (no `wts:calc` dispatch, `flowSeq` unchanged), (stub sim with `fakeFuSnapshot`); 3D table filters, clearance, frost, rebuild key with the destination (wts3d-test section) |
| `prism-build/wts-sim-perf.js` | WP0 | `--base v331` default (`--base v33` keeps the old pair); new `--case ck2` and `--case cushion` modes for the secondary ratios |
| `prism-build/wts-calc-golden.js` | WP0 | writes / checks `_wts-calc-v331.js` (the harness `calcWTS` in a stub DOM, as wts3d-test does), strict `===` on `BASE_FIELDS`; `--time` runs the timing gate of §10 against `_wts-calc-v331-src.js` |

### 9.3 GUI sweep and browser checks (WP-L, lead)
- `gui-sweep.js --route wts --quick`: blank / 0 / −1 / 1e12 on the four new inputs; the cushion form; the bean2 buttons.
- Browser check: add CK-102, pinch it to 32/64, bypass the heater, V-101 out → line 300 → FS-401 out → back to flare,
  cushion start → breakthrough → done at ×60. Each step is shown in 2D, in 3D and on a phone at 390 px. Project Open and New
  with CK-102 in: no nested `wts:calc` (one dispatch per calc in the console log).

---

## 10. Performance and determinism
- **Gate (default spread: CK-102 out, dest flare, no cushion): new / v3.3.1 ≤ 1.05.** It uses both gate values of
  `wts-sim-perf.js` (minRatio over rounds, pooled medianRatio; SIM-EQUIPMENT-PLAN §7 method). The default spread includes
  the two new history writes (`Pck2`, `cushionLeft`) and the hoisted guards. E1 and E2 each re-run it before handing over,
  and the lead re-runs it after each merge. WP0's perf A/A (±0.03) runs with the history additions stubbed in, so they are
  measured.
- **Hot-path rule**: every new per-substep block sits behind `CK2.act || X.ck2dP !== 0`, `bypLine`, `ventOn` or `cushOn`.
  All are hoisted in `derive()` (or closure booleans for the cushion). `X` keeps only doubles: the lag `X.ck2dP` is a
  double initialised in `initState`, and the cushion state is the separate closure object `cushS`, so `X`'s field kinds do
  not change. `pDown()` reads only hoisted locals and closure doubles, with no cfg lookups per call. The two history
  keys are constant number writes. A code-review check lists the guarded blocks.
- **Secondary ratios** (against the default spread in the same context): CK-102 in ≤ 1.10; cushion running ≤ 1.15; dest
  'line' ≤ 1.05.
- **Host `calcWTS` gate** (WP-C; `wts-calc-golden.js --time`): 10 runs of the default input set in the stub harness, after
  2 warm-up runs; the median of the new `calcWTS` (four walks incl. `QmaxPair`) over the median of the frozen v3.3.1 text
  (`_wts-calc-v331-src.js`) in the same process **≤ 4.0**, and the CK-102 + V-101-out set ≤ 6.0. It runs on every keystroke,
  bean2 click and `runHostCalc` in the tests and the GUI sweep, so it is a gate for WP-C and at each merge.
- `perf-budget.js` at WP-I (bundle ≤ baseline × 1.10).
- **Determinism**: no new draws from the main PRNG (a stalled well keeps the existing draws and does not apply them). Same
  seed → same state with every item on. The host walk uses fixed iteration counts (no convergence tests). Breakthrough is
  located by `chooseH` on the delivered rate, so dt 1 and dt 10 agree on `tBreak` to one substep of the larger dt.

---

## 11. Help-content updates (WP-HC; after the Help release has merged; files of the Help plan)
Do not edit any help file before the `help` branch has merged to `Dev`. WP-HC then branches from `sim-fu` with `Dev` merged
in (§12.4). The Help branch already ships `afterSim` variants for FS-1 and FS-2 (`48-calc-help-simcourse.js` l.157 / l.169)
that `49-calc-help.js` l.476 shows **as soon as** `WTS_sim.features.bypassDest` is true, and its `pageIssues()`
(`help-content.test.js` l.388-395) fails for any id'd control in `#pgBody` that is neither in the guide's `inputs[]` nor in
`notDocumented`, and checks labels and verdict coverage exactly. So the simulator cannot ship without the minimal part.

**WP-HC minimal (M, ships with the simulator, gate for WP-I):**
| File | Change |
|---|---|
| `48-calc-help-welltest.js` (`wts` reference) | `inputs[]` entries for `wts_bean2`, `wts_ck2Pos`, `wts_sepByDest`, `wts_sepByP` with the exact `LABELS` (D17) and categories (`count` for bean2); `notDocumented` entries with reasons: pattern `^wtsl_cush_` (Scenarios dialog, device prefs) and the id'd bean2 / cushion buttons 38 renders inside `#pgBody`; verdict cases for every new ⚠ text of §4.5 (the help test's verdict coverage); the "Surge Tank Pressure" text: the `Psep − 10` bound applies only with V-101 in (`flow.sepBy.surgeP_psig`, §4.4) |
| `48-calc-help-simcourse.js` | FS-1 / FS-2 `afterSim` texts checked against the shipped labels (they already use "With V-101 out, well stream to", "Burner / flare line", "Production line pressure", "To production line"); FS-1 keeps `feature: 'bypassDest'` (`help-course.test.js` l.351 requires it), which is safe because `features.cushion` is set by the same build (D14) |
| `tests/help-content.test.js`, `tests/help-course.test.js` | **owned by WP-HC for this release**: any assertion that pins the old "today" strings (`help-course.test.js` l.457-466) or the `afterSim` / feature pairing is updated with the content, in the same commit |

**WP-HC full (S; may slip to the next release without blocking the simulator, the minimal part then stands):**
| File | Change |
|---|---|
| `48-calc-help-welltest.js` (`wts` reference) | Rig-up: CK-102 row ("on the H-101 inlet, in line only through the heater"; position option). Cards: CK-102 card and the bean2 buttons. Alarms: `CHOKE2_LIMIT`, `CK1_SUBCRIT`, `PAH_CK2`, CK-102 hydrate, `PSHH_SEPBY`, `SEPBY_RATING`, the five cushion warnings. Scenarios: Cushion unload. The "which pressure goes where" table gains a row: "Production line (V-101 out) → **Production line pressure** with destination = Production line". Protection: NRV-501 / XV-501 / PSHH-104 at the tie-in, the design pressure between the chokes |
| `48-calc-help-simcourse.js` | **FS-1 becomes proper**. The main text is the new flow: V-101 out, destination Burner / flare line, then Scenarios → Cushion unload with volume, SG and rate. WHP rises by itself; the bean can limit the liquid (`CUSH_LIMIT`); breakthrough and tail; `CUSH_BURNER` for any cushion to the burner (water: flame-out; oil / diesel: fallout and burning liquid); warm the heater before breakthrough; through V-101 the water dump limits the rate (`CUSH_DUMP`). Steps 2 and 7 of today's text (lowering the Operating Pressure and the Surge Tank Pressure) and the surge-warning catch are removed. The "today" text stays only as a short note for v3.3.2 users behind `!WTS_sim.features.cushion`. **FS-2 becomes proper**: V-101 out with destination Production line at P psig; FS-401 may be out (tank relief to vent); totals "to production line"; NRV-501 / XV-501 and PSHH-104; the chokes may go subcritical (`CK1_SUBCRIT` / host warning). The "what it gets wrong" list shrinks to the constant line pressure (a real header varies), no blocked-outlet dynamics and no metering by design. **FS-4 cold start-up** gains the CK-102 staging (pinch CK-102 while opening CK-101; keep both nodes ≥ 10 °F above the hydrate temperature; the `inlet` vs `midcoil` caveat; PAH-102 and the blocked-in rating). A new **exercise "Staging the drop with the heater choke"** (C): bean2 48 → 32, watch `CK1_SUBCRIT` and `CHOKE2_LIMIT`, then 64 |
| Checks | FS-1 / FS-2 `example.check` entries move from `manual` to **live checks** (Round 7 is in the harness): `WTS_state.flow.sepBy.choke.Pout` and the cushion `tBreak` / `recovered_bbl` from `ANCHORS_CUSH` (§6.4, re-anchored). The existing page checks (a)–(e) stay, because the base fields are unchanged (D2) |
| Shots | Recipes for the CK-102 card, the live 2D two-stage row and the cushion HUD; run `help-shots --route wts` after the content freeze, then the Round-9 rebuild (manifest module) as the Help plan's WP-I says |

WP-HC owns the two content files, their recipes and, for this release, the two Help tests named above. All Help tests must
pass at WP-I.

---

## 12. Work packages

### 12.1 Packages, order and owners
| WP | Owner | Depends on | Content | Gate |
|---|---|---|---|---|
| **WP0** contract, frozen copies, tools | lead | — | Branch `sim-fu` from `Dev` at or after `3611343`; `_wts-sim-v331.js`; `wts-calc-golden.js` (12 literal input sets, storage cleared, `--time`) + `_wts-calc-v331.js` + `_wts-calc-v331-src.js`; `wts-sim-perf.js --base`; `_wts-fu-shapes.js` (with `LABELS`, `BASE_FIELDS`, `ANCHORS_CK2`, `ANCHORS_CUSH`, re-computed with a prototype `wtsWalk` and a prototype cushion step in the scratchpad; `COUNT_SITES` from the §3.6 grep); the sig helper changes in `_wts-equip-shapes.js`; `wts-fu-identity.test.js` (green on the unchanged tree); this plan | full accept `--sources` green; identity green on the unchanged tree; perf A/A within ±0.03 |
| **WP-E0** foundation | builder A | WP0 | 31: §3 rig-up incl. `rigRenorm` on all three paths, §5.1 registries, `DEFAULTS` additions, `flowDerived`, `SAMPLE_FLOW.sim` (+2), exports / VERSION / `features`, snapshot blocks with static placeholders, **`pickSteadyBlock()`** for all four cases (§5.2), `pckLive()`, the `ck2Info()` accessor, `X.ck2dP` and the `cushS` / `cushOn` closure state, the history writes, `startCushion` / `stopCushion` / `getCushion` stubs (`{ok:false, msg:'not available yet'}`), **two labelled stub sections** with guarded hooks and call sites (`ck2Derive(sel)`, `ck2Step(h)`, `ck2Refresh(s)`, `ck2Alarms`, `ck2Rig(phase, old, r, parts)`; `bypPDown()`, `bypAccount(byG, byO, byW)`, `bypRefresh(s)`, `bypAlarms`, `cushStep(h)`, `cushChooseH(c)`, `cushAlarms`, `cushBalance(op, o)`), the refresh l.2025-2050 and history l.1463 lines turned into those hooks; the §3.6 count changes; self-tests. 38 foundation (§8.3 first bullet, §3.4) | every existing test green; identity v3.3.1 and v3.3; perf ≤ 1.05 |
| **WP-C** host walk | builder C | WP0 | `wtsWalk` refactor (rate scale, outer fixed point, guards), `flow.ck2` / `flow.sepBy` with their warnings, the four inputs, `WTS_IDS`, `flow.sim`, `wtsRenderResults`, the CK-102 rbox, Node-table rows, the blocked-in check, `wts-host-patch.js` markers; host parts of the two new tests | golden identity (strict); anchors; `wts-host-patch.js --check`; `calcWTS` timing gate (§10) |
| **WP-E1** CK-102 engine | builder A | WP-E0 | §5 in its section and hooks (`ck2Derive`, `ck2Step`, `ck2Refresh`, `ck2Alarms`, `ck2Rig`); the engine part of `wts-heater-choke` | its tests; identity; perf |
| **WP-E2** bypass + cushion engine | builder B | WP-E0 | §6 in its section and hooks (`bypPDown`, `bypAccount`, `bypRefresh`, `bypFlareQ`, `bypVentHist`, `bypAlarms`, `cushStep`, `cushChooseH`, `cushAlarms`, `cushBalance`, `cushHeater`, `cushTsep`, `cushBatch`; the full list is the WP-E2 section header in 31); reads CK-102 data only through `ck2Info()`; the engine part of `wts-bypass-cushion` | its tests; identity; perf |
| **WP-3D** | builder D | WP0 (fixture), WP-E0 for live runs | §8.1; wts3d-test 3D checks; 32 self-tests | framing gate (4 combinations + V-101 out 'line', 2 sizes) |
| **WP-L** HMI | builder E | WP0, WP-E0 | §8.3 except the foundation and the 2D overlay; the iOS dialog rule; GUI sweep job | its tests |
| **WP-2D** | builder F | WP0, WP-E0 | §8.2 live 2D (host `WTS_DIAG_LAYOUT`, `wtsDrawDiag` live branch, `wtsEqChkS`) + 38 2D overlay functions; reads only `liveNodes` / the snapshot, not `flow.ck2` | its tests; divert glyph tests unchanged; static diagram byte-identical |
| **WP-HC** help content | writer C (simulator-literate) | Help release merged to `Dev` and `Dev` merged into `sim-fu`; WP-E1 / E2 anchors | §11 minimal (M) and full (S) | help content and course tests |
| **WP-I** integration + release | lead | all | merge, Round-7 rebuild, full suite, perf, GUI sweep, browser checks, §13 | §12.5 all green |

Builders A and B may be one person (E1 then E2); the plan then loses about a day. WP-C is on the critical path for the host
halves of the tests: it starts on day 1 against the fixture shapes. E1 and E2 never edit the same lines: the selection
(`pickSteadyBlock`), the refresh / history hook sites and the `ck2Info()` accessor are E0's, so the merge order E1 → E2 does
not decide any semantics.

### 12.2 File ownership
| File | Owner (others must not edit) |
|---|---|
| `prism-build/31-wts-sim.js` | WP-E0 (constants, rig-up, contract, `pickSteadyBlock`, `pckLive`, `ck2Info`, hook sites); then WP-E1 (CK-102 section + its hooks) and WP-E2 (bypass / cushion section + its hooks). A missing constant or hook goes to the lead |
| `prism-build/32-wts-3d.js` | WP-3D |
| `prism-build/38-wts-live.js` | WP-E0 foundation; then WP-L, except `draw2dLive`, `drawRig2d`, `RIG2D`, `drawStrip`, `valves2d`, `zones2d`, `nearValve` and the 2D click branch → WP-2D |
| `well-testing-app.html` | WP-C (`calcWTS`, `wtsWalk`, `wtsRenderResults`, inputs, results, `WTS_IDS`, `flow.sim`); WP-2D (`WTS_DIAG_LAYOUT`, `wtsDrawDiag` live branch, `wtsEqChkS`; `wtsEqChk` unchanged); lead (`RELEASE_NOTES`, `#appVersionLabel`). WP-C and WP-2D edit disjoint functions; the lead merges |
| `prism-build/wts-host-patch.js` | WP-C (done markers only, if one must change) |
| `ios-app/ios-additions/ios-styles.css` | WP-L (one rule, own block after the Help rules) |
| `prism-build/wts3d-test.js` | sections E0 / 3D / L / 2D; lead merges |
| `tests/_wts-sim-v331.js`, `_wts-calc-v331.js`, `_wts-calc-v331-src.js`, `_wts-fu-shapes.js`, `_wts-equip-shapes.js`, `wts-sim-perf.js`, `wts-calc-golden.js`, `wts-fu-identity.test.js`, `wts-equipment.test.js` | WP0 / lead |
| `tests/wts-rigup.test.js`, `wts-desander.test.js`, `wts-surge2.test.js` (count sites) | E0 (engine, persistence), L (live view) |
| `tests/wts-heater-choke.test.js` | WP-C (host group), WP-E1 (engine group) |
| `tests/wts-bypass-cushion.test.js` | WP-C (host group), WP-E2 (engine group) |
| `tests/wts-fu-views.test.js` | L, 2D (groups); lead merges |
| `48-calc-help-welltest.js`, `48-calc-help-simcourse.js`, their shot recipes, `tests/help-content.test.js`, `tests/help-course.test.js` | WP-HC, only after the Help merge |
| `README.md`, `CLAUDE.md`, `PROJECT-NOTES.md`, this plan, iOS version stamps, `smoke-test.js` | lead |
| Generated: `combined-round7.js`, `ios-app/www/index.html`, help shots / manifest | integration only |

### 12.3 Rules for parallel worktrees
- One worktree and branch per WP from `sim-fu` after WP-E0 (WP-C, WP-3D and WP-L may start from WP0 and rebase on WP-E0).
  Nothing merges into `Dev` before WP-I.
- Builders never run `inject-round7.js` on the HTML. Round 7 is rebuilt in memory by the harness, so the gate is
  `accept-test.js --sources` plus `wts3d-test.js`, plus `wts-sim-perf.js` for 31. `--html` applies after the WP-I rebuild.
- WP-C edits the host by hand (no round). It does not touch the injected Round-7 block and never uses `sed -i` on the
  host. LF on a Linux checkout.
- View builders code against `_wts-fu-shapes.js` / `fakeFuSnapshot` and the stub sim, never against `_internal`.
- Advance `sim-fu` only from the worktree that has it checked out (`git merge --ff-only`).
- No help file is edited while the `help` branch is unmerged (A Help-centre release is in flight).

### 12.4 Merge order (lead)
On `sim-fu`: WP-E0 → WP-C → WP-E1 → WP-E2 → WP-3D → **merge `Dev` (with Help) into `sim-fu`** → WP-L → WP-2D → WP-HC.
After each merge run `accept-test --sources --grep wts`, `wts3d-test.js`, `wts-sim-perf.js`, the golden check and its
`--time` gate. The Help merge comes before WP-L because the Help branch also edits `smoke-test.js` (+30 lines),
`ios-app/ios-additions/ios-styles.css` (+25), `sync-from-main.js` and `sw.js`: WP-L rebases on it and places its CSS rule
in its own block after the Help rules, and every count quoted from then on (smoke checks, acceptance tests, sweep routes) is
taken from the merged tree, not from this plan. If Help has not reached `Dev` when WP-L is ready, WP-L waits on its branch
(the simulator release follows the Help release anyway). Then do the Round-7 rebuild, the engine-backed view tests, the full
suite, perf, the GUI sweep and the browser checks. Then the release items, `sim-fu` → `Dev` `--no-ff`, push, and `Dev` →
`master` once verified (CLAUDE.md branch model; resolve `ios-app/www/index.html` and `ios-app/www/help/**` with Dev's copy).

### 12.5 Rebuild and verification
As SIM-EQUIPMENT-PLAN §10.5 (Round-7 pair, LF check, sync, main-script extract, `node --check`, smoke (the post-Help count
from the merged tree), accept `--html --integration` and `--sources`, wts3d-test, `wts-sim-perf.js`, `perf-budget.js`),
plus `node prism-build/wts-calc-golden.js --check --time` and `node prism-build/wts-host-patch.js --check`. Help has merged
by then, so also `help-shots.js --check`, the guide sync test and the Help content / course tests. At the end run the
CLAUDE.md full incantation with the Round-7 pair and check that `git diff --stat` touches only the expected files.

---

## 13. Release items (lead, WP-I)
- **Version**: the next point release after `RELEASE_NOTES[0].ver` at WP-I (v3.3.3 if Help ships as v3.3.2). Use the same
  value in `RELEASE_NOTES[0].ver`, both `MARKETING_VERSION`, both `VERSION_BASE` copies and the `#appVersionLabel`
  fallback. `WTS_sim.VERSION = '1.5.0'`.
- `RELEASE_NOTES` first entry (draft):
  ```
  { ver:'v3.3.3', date:'<release date>', title:'Simulator: heater choke, bypass destination &amp; cushion unload',
    note:'The Well Test Simulator can stage the pressure drop with a second choke on the heater inlet, send the well stream to the burner line or a production line with the separator bypassed, and unload a completion cushion. With the new items left out the simulator runs as before.',
    items:[
      ['new', 'Heater inlet choke', 'CK-102 can be added to the rig-up on the H-101 inlet (or between the coil passes). The steady check and the live view show the pressure between the chokes, each choke regime, which choke limits the rate, the J-T cooling per stage and the CK-102 hydrate margin; it goes out of line with the heater bypass. A pressure alarm PAH-102 and a blocked-in check guard the line between the chokes.'],
      ['new', 'Bypass destination', 'With V-101 out the well stream goes to the burner / flare line or to a production line at a set pressure; the choke check and the live back pressure use that pressure, the flare can be out for a production line (tank relief then goes to vent), and the totals go to the line. The tie-in shows a non-return and an isolation valve, and PSHH-104 on the bypass path trips SDV-101.'],
      ['new', 'Cushion unload', 'Scenarios → Cushion unload: cushion volume, SG and unload rate; WHP rises as the column unloads, the bean can limit the liquid rate, then gas breakthrough and a cushion tail, with the volume recovered by destination and warnings for a well that cannot lift the cushion, any cushion sent to the burner, a separator water dump that is too small and a heater at full firing.'],
      ['calc', 'V-101-out back pressure', 'With the separator bypassed, the choke outlet now uses the whole-stream line loss to the destination instead of the separator-gas line loss.'],
      ['ux', 'Field scenarios', 'The Help field scenarios for unloading to the burner and flowing to a production line use the new settings.'] ] }
  ```
  (the last item only if the full WP-HC part ships; the minimal part ships in any case, D18).
- `README.md` simulator line: "+ heater inlet choke, bypass destination (burner line or production line) and a
  cushion-unload scenario".
- `CLAUDE.md`:
  - Round-7 file-map line: 31 CK-102 / bypass destination / cushion; signature 11.
  - Tests: `_wts-sim-v331.js` frozen, `_wts-calc-v331.js` golden + `_wts-calc-v331-src.js` + `wts-calc-golden.js`
    (`--check --time`), `wts-sim-perf.js --base`; `calcWTS` never reads the rig-up (display via `wtsRenderResults`).
  - Known limitations: rate algebraic on the steady walk; the heater 5 psi not re-solved with H-101 out; cushion
    liquid-only orifice law, no multiphase critical correlation, mixing in V-101 ignored, oil / diesel to the burner not
    modelled; cushion column law from SITHP with a straight-line deliverability (ASSUMPTION); `midcoil` duty split fixed
    50 / 50 and linear μJT after pass 1 (conservative); J-T capped cumulatively at 150 °F; no coil or LP-pass relief path
    (design pressure, PAH-102 and a blocked-in check only); production line at constant pressure, no blocked-outlet
    dynamics, seg-5 geometry reused for the line run and no riser elevation; heater rating = 1.25 × steady duty.
  - Stats.
- `PROJECT-NOTES.md`: a newest-on-top entry.

---

## 14. Open questions — chosen defaults (builders do not stop to ask)
| # | Question | Chosen default |
|---|---|---|
| Q1 | CK-102 location | Heater inlet, downstream of the bypass tee (as asked); `midcoil` option (C, D10) |
| Q2 | CK-102 initial bean | 48/64 (D9). Alternative: 128/64 fully open (no effect until pinched) — the owner may choose |
| Q3 | `wts_sepByP` units | Untagged psig (Dynamic Simulation card rule); Metric mode shows the psig label, as the other card inputs do |
| Q4 | Production line default pressure | 150 psig (HELP-GUIDE-PLAN Q16), range 0–1440 |
| Q5 | Cd of CK-102 | Shared `wts_Cd` |
| Q6 | New faults | None this round (D12); a CK-102 hydrate plug fault is a later candidate |
| Q7 | Cushion defaults | 50 bbl, SG 1.03, 1,500 bbl/d, 3-1/2″ (0.00870 bbl/ft), depth 10,000 ft, G_r 0.08 psi/ft, gas fraction 5 %, tail 15 % / 1,800 s (D7; supersedes HELP Q15) |
| Q8 | Cushion inputs location | Scenarios form, device prefs, not in the page report (D5) |
| Q9 | Cushion persisted across reload | No; Reset stops it |
| Q10 | Well that cannot lift the cushion | Stall: all well rates 0 with `CUSH_NOLIFT`, un-stall with 25 psi hysteresis; nitrogen lift / swab not modelled |
| Q11 | Cushion to the burner | Allowed with a `CUSH_BURNER` warning for any cushion liquid (no trip); the text depends on SG (water / brine: flame-out; oil / diesel: fallout and burning liquid) |
| Q12 | Research gas-choke coefficients vs `calcWTS` (17.4 vs 10.7 MMscf/d at 32/64) | Use the `calcWTS` law as is; WP0 records why they differ (Cd, T, Z, P basis) in the WP notes and does not change CK-101 |
| Q13 | Heater 5 psi with H-101 out in the V-101-out walk | Engine leaves out `heater.dP`; segments not re-solved (≤ 5 psi; stated) |
| Q14 | Suggested intermediate pressure | Not this release (C later) |
| Q15 | Coil / line rating between the chokes | Design pressure 1,440 psig (B16.5 Class 600, ASSUMPTION; `cfg.heaterChoke.designP_psig`). Host warning when the blocked-in SITHP exceeds it (CK-102 in), engine `PAH_CK2` at 90 % from the live Pm; text by position (D16). No relief path model |
| Q16 | Modbus / Mini WellOS tags | Follow-up release |
| Q17 | Scenarios menu order | Existing entries in their order, then "Cushion unload (clean-up)" |
| Q18 | Release if WP-HC is late | The **minimal** WP-HC part (D18, §11) is M and gates WP-I: the Help tests fail without it and the FS-1 / FS-2 `afterSim` texts appear as soon as the simulator ships. Only the **full** part (S) may move to the next release |
| Q19 | Release version | Next point release after the current `RELEASE_NOTES[0].ver`, fixed at WP-I |
| Q20 | Burner / flare line inlet pressure with V-101 out | `cfg.sep.bypass.P_flare_psig` 5 psig (equal to the PCV default, so identity holds); the PCV setting applies only with V-101 in |
| Q21 | Bypass-path design pressure and PSHH-104 | 1,440 psig (ASSUMPTION), PSHH-104 at 90 %, trips SDV-101 |
| Q22 | Tank relief with V-101 and FS-401 out | To a `vent` sink with its own total; the tanks are not forced out of the rig-up |
| Q23 | H-101 rating for the cushion duty | 1.25 × steady duty (ASSUMPTION; no rating input); `HTR_FULL` when it binds |
| Q24 | Water dump with V-101 in during a cushion | `Cv_w` fixed as sized; `startCushion` warns and `CUSH_DUMP` is raised; LAH / LSHH act |
| Q25 | Liquid-only well (Qg 0) with CK-102 | The two-stage gas walk is skipped with a note; CK-102 in line with ΔP 0 |

---

## Appendix A — line references (v3.3.1, `3611343`; from `simfu/audit.md`)
- **31**: TAGS l.110, NAMES l.116, RIG_KEYS l.136, RIG_ITEMS l.139, RIG_OPT* l.153-156, normRigup l.168 / forced flare
  l.173 / notes l.177 / T-202 rule l.181, STEP_ORDER l.196, NODE_IDS l.207, flowDerived l.396, applyRig l.451, derive l.582
  (chk l.593-596, limFac l.597, bypass l.592, steady nodes l.601-611), Cv_w l.652, massErr l.779-788, pDown l.964-968,
  Q lists l.1317, processAlarms l.1337, history l.1462-1463, WGRAD / water dump l.1573-1574, accounting l.1727-1728, rate
  targets l.1745-1750, X.f l.1751, WHP l.1758-1763, shut-in PBt l.1765, warm-up l.1769, chooseH l.1833 / gated block
  l.1869, snapshot l.1882ff, designAlarms l.1998-2007, refresh l.2025-2050, mut l.2226, RIG_TXT l.2494, rigRefusedNow
  l.2504, setRigNow check l.2526 / re-derive l.2549, desCoupling l.2716, DX.PD lag l.2739-2760, exports self-test l.4256.
- **32**: EQ_IDS … PREF_SIDE l.57-67, ANCHORS l.70, PROXIES l.107, EQ_BOX l.136, HALO l.159, NULLABLE l.174, E3c / E3b
  l.212-213, D1/D2 l.233-234, NEW_ROUTES l.248, BYPASS_SPOOLS l.257-260, RIG_GROUPS l.263, NODE_NAMES l.678-679,
  fakeSnapshot l.925-1001, CK-101 block l.1831-1843, heater inlet valve l.1940.
- **38**: EQ_IDS l.48, STEP l.50, TAG / NAME / ABBR l.52-58, HOST_NM / NODE_KEYS l.60-61, RIG_FALLBACK l.80, INPUT_FOR
  l.89, liveNodes l.222, setRig l.1416, choke card l.2177, heater card l.2190, bean action l.2422 / l.3599, draw2dLive
  l.2830, drawRig2d l.3048, heater mask l.3113, labels l.3117 / l.3121, valves2d l.3226, zones2d l.3244, Scenarios
  `faultList()` l.3395.
- **Host**: `WTS_IDS` l.129377, `renderWTS` l.129378, Heater card l.129406, Dynamic Simulation l.129414, `calcWTS`
  l.129452 (surge clamp l.~129470, choke walk l.129540-129568, seg 5 l.129577, choke rbox l.129630ff), `WTS_DIAG_LAYOUT`
  l.129722, `wtsDiagLayout` l.129729, `wtsDrawDiag` l.129736, `wtsEqChk` l.129913.
- **Tests**: `_wts-equip-shapes.js` l.81 / 422 / 513-514; `wts-rigup.test.js` l.101-136; `wts-equipment.test.js` l.212 /
  290 / 469 / 540 / 550 / 573 / 625; `wts3d-test.js` l.144 / 205 / 209 / 756 / 765 / 896.

---

## Appendix B — WP0 notes (lead, 2026-11-06, branch `sim-fu` from `dev-87qwkg` = `52edeac`, at or after `3611343`)

**Files (WP0 / lead).**
- `tests/_wts-sim-v331.js`: 31 at `3611343` (VERSION 1.4.0, sha256 of the source in the header), self-test stripped by
  `concat-round7.js` `stripSelfTest()`; `loadEngine('v331')` in `_wts-equip-shapes.js` loads it in its own vm context.
  `_wts-sim-v33.js` and its tests are unchanged.
- `prism-build/wts-calc-golden.js` (`--write`, `--check` (default), `--time`, `--json`) with the 12 literal input sets, and
  `tests/_wts-calc-v331.js` (generated, never edit), `tests/_wts-calc-v331-src.js` (frozen calcWTS region of `3611343`).
  - **The calcWTS region** is the host text from the line `const WTS_PIPES=` up to `const WTS_DIAG_LAYOUT` (WTS_PIPES,
    WTS_IDS, renderWTS, calcWTS). WP-C keeps `wtsWalk`, `wtsRenderResults` and every helper calcWTS needs **inside** it.
  - Stub DOM: `$` returns the input elements of the set and creates `#wts_res` / `#wts_warn` / `#wts_regime`; any other id
    is `null` (so calcWTS must guard a missing new input, as an old page has none). `fmt` is the page's en-US formatter;
    `saveInputs`, `wtsDrawDiag` are no-ops; a fresh storage stub per run with `wts_page_wts` and `wts_sim_rigup` cleared,
    every `getItem` key recorded.
  - The 12 sets: `defaults` (also Help FS-1 (e) and FS-2: the FS-2 page case is the default spread), `fs1a`–`fs1d` (Help
    FS-1 (a)–(d)), `fs1c100` (FS-1 WHP 100), WHP 500 / 60 / 2,000, bean 16 / 64, heater bypass. The golden holds the
    BASE_FIELDS of `flow` and the page output (`#wts_res` / `#wts_warn` HTML, display, `#wts_regime` text and colour).
  - `--check` runs every set five times: plain, with the four new inputs present (three value sets, incl. `wts_sepByP` 0
    and `line`) and with a stored CK-102 / V-101-out rig-up; base fields strict `===` (sign of 0 and NaN included), page
    output exact, no read of `wts_sim_rigup`, exactly one `wts:calc` dispatch. With no `rig` given, `wtsRenderResults`
    must therefore leave the v3.3.1 page byte-identical (§4.5).
  - `--time`: a run is 20 calcWTS calls; 2 warm-ups, 10 interleaved runs, median ratio. Measured at WP0 (A/A, same text):
    defaults 0.99, CK-102 + V-101-out inputs 1.01 (about 2 ms per call in the stub, most of it the results HTML).
- `wts-sim-perf.js`: `--base v331` (default) | `v33`; secondary cases `--case all|both|ck2|cushion|line` (gates 1.6 / 1.10 /
  1.15 / 1.05; each skipped with the reason until the engine and the host have it: `features`, `startCushion`, a host
  `flow.ck2`); `--probe hist` stubs the two history keys into the working source (constant number writes per sample).
  Measured at WP0 (7 rounds × 10 pairs, 4 h, unchanged engine): without the probe min-ratio median 0.997, pooled median 1.004; with `--probe hist` 0.994 / 1.016 (A/A within ±0.03); both-in ratio 1.46 (gate 1.6); the three new cases skipped.
- `tests/_wts-fu-shapes.js` (§7.3) and `tests/wts-fu-identity.test.js` (7 tests, green on the unchanged tree).
- `_wts-equip-shapes.js` sig helpers (§3.6): `SIG_DEFAULT` is now the 11-character `'11111111000'`, the v3.3.1 default is
  `SIG_DEFAULT_V331`, and `sigDefaultOf(S)` picks by `S.VERSION` (1.4.0 → 10 characters, else 11), so the tests that used
  `SIG_DEFAULT` stay exact before and after WP-E0. `checkShape('rigup', o, {rigKeys})` takes the module's RIG_KEYS (extra
  keys are booleans, sig length must match, the module's own optional keys are valid extras); the regex is `{10,}`;
  `identityDiff` accepts only zeros after the compared prefix (`/^0*$/`). `wts-equipment.test.js` uses `sigDefaultOf(S)` /
  `SIG_DEFAULT_V331` and `/^0+$/` for "optional items out"; its other count sites stay for WP-E0 (COUNT_SITES).

**ANCHORS_CK2 (re-computed; prototype `wtsWalk` of §4.3 in the scratchpad, base walk reproduced bit for bit against the
golden).** Defaults (CK-101 32/64, 10 MMscf/d, 1,000 / 200 bbl/d, WHP 3,000, Psep 150; Pci 2,999.26):

| CK-102 | Pm (psig) | CK-101 P2/P1 | CK-101 | QmaxPair | limiter | flow-limited | Tco2 / heater inlet (°F) | duty (MMBtu/h) |
|---|---|---|---|---|---|---|---|---|
| 4/64 | No Flow | — | — | 0.167 | CK-102 | yes | — | — |
| 24/64 | No Flow | — | — | 5.695 | CK-102 | yes | — | — |
| 32/64 | 2,753.6 | 0.919 | Subcritical | 8.920 | CK-102 | yes | 170.4 / 68.68 | 2.1045 |
| 40/64 | 1,659.5 | 0.556 | Subcritical (just) | 10.659 | CK-102 | no | 127.6 / 68.68 | 2.1045 |
| **48/64** | **1,135.1** | **0.382** | Critical | 10.710 | CK-101 | no | 107.0 / 68.68 | 2.1044 |
| 64/64 | 634.4 | 0.216 | Critical | 10.710 | CK-101 | no | 87.4 / 68.69 | 2.1042 |
| 96/64 | 278.2 | 0.098 | Critical | 10.710 | CK-101 | no | 73.5 / 68.71 | 2.1037 |
| base (no CK-102) | — | 0.0572 | Critical | 10.710 | — | no | — / 68.735 | 2.1031 |

- 32/64 is a state that exists (Pco2 < Pci) but cannot pass 10 MMscf/d: flow-limited, limiter CK-102 critical with CK-101
  subcritical, as §4.6 says. Rule of thumb confirmed: CK-101 critical at 48 (≥ 1.35 × 32), subcritical at 40.
- **Limiter 'both'** needs both chokes subcritical at the pair capacity, which at Psep 150 does not happen (equal beans
  give 'CK-102'). It appears at a high back pressure: Psep 1,500 with 32/64 + 40/64 (QmaxPair 10.391, not limited) and
  with equal beans 32/32 (8.844, limited). The fixture's 'both' anchors use Psep 1,500 (§9.2 "equal-bean and
  both-subcritical cases" read at that pressure).
- midcoil 48/64: same pressures and duty; Tp1 = 125.0 = Tho − 25 (the cap binds), CK-102 outlet 86.66 °F.
- Dry gas (Qo = Qw = 0, 10 MMscf/d passes: base Qcrit 10.712): stages 137.85 + 12.15 = 150 °F; heater inlet T and duty
  differ from the CK-101-only walk by 0.002 °F and 0.002 %. Recorded tolerance: 0.5 °F and 0.5 % duty.
- Prototype choices (WP-C may differ within the 0.5 % anchor tolerance): Phi2 by 6 seg-4 passes back from P0; the first
  outer pass evaluates seg 3 at Pm; T3 from seg 3 re-evaluated at the new (Pco2, Tco2); Z3 at (Pm, T3); the QmaxPair
  Illinois solve takes F(0) = Qcrit and, when none of Q0·2^k fails, Qhi = 1.0001·Qcrit (CK-101 can never pass more);
  both chokes critical at the pair capacity → limiter 'CK-101'; the midcoil split uses Tho = max(Thtr, T3).

**ANCHORS_CUSH (prototype cushion step of §6.3 on SAMPLE_FLOW, V-101 in, noise off).** Z at the wellhead is 0.904 (not
0.85), so Bgwh = 0.000967 rb/scf, qRes_ss = 10,869 rb/d, fUnload = 0.182; WHP target at the start 1,702.6 psig, end of the
main slug 3,490.5; tBreak = 2,468 s after the start (42.5 / q + τf), Vtail 7.153 bbl, done ≈ tBreak + 8,933 s (3.16 h after
the start). §6.4's numbers stand within these corrections. Two points for WP-E2:
- the "62.5 bbl after 1 h" unit test cannot run on the defaults (breakthrough at 0.68 h): the anchor uses V 500 bbl with
  gasFrac 0 (62.153 bbl = 62.5 − τf·q);
- a substep-constant tail target over-delivers by about h/(2·τt)·Vtail (0.02 bbl at dt 10, 0.04 %), inside the 0.1 % gate;
  the exact exponential integral over the substep removes it, and makes `done` agree between dt 1 and dt 10.

**Q12 (gas-choke coefficients).** The calcWTS CK-101 capacity at 32/64 is 10.71 MMscf/d: 879.77 · Cd 0.85 · A 0.0491 in² ·
P1 3,014 psia / √(SG 0.65 · T1 639.6 °R · Z1 0.904) · √fInner(r_c 0.549) (0.469). Cd 1 gives 12.60, Cd 1 at 519.67 °R
13.98, Cd 1 at 519.67 °R and Z 1 13.29: none of Cd, T basis or Z reaches 17.4, so the research note's figure comes from its
own coefficient (the session note is not in the repository and was not re-derived). CK-101 is unchanged.

**Counts.** D12 lists eleven new alarm ids (§9.1 says thirteen): the fixture has 11, in Q_CK2 (4) / Q_SEPBY (2) /
Q_CUSH (5). COUNT_SITES records every hit of the §3.6 grep on the WP0 tree (this fixture excluded): 64 hits — 32 rig counts with their owner (WP-E0 24, WP-3D 8), 4 done at WP0, 26 not rig counts, 2 frozen copies.

**Fixture conventions decided at WP0.** `flow.ck2` / `flow.sepBy` warnings are `{t, msg}` (the base keeps `{t, m}`);
`nodes.heaterChoke.bean` is 0 and `pos` 'inlet' while no block exists (only `inputs.bean2` / `inputs.ck2Pos` are nullable);
`limiter` and `regime` are '' while CK-102 is out; `PSHH_SEPBY` is sev 'trip' with `esd` (the DES_PSHH path), eq
'separator'; `SAMPLE_FLOW_SIM_KEYS` lists the 9 keys after the v3.3 five.

**Gates at WP0.** accept `--sources` 1179/1179 (incl. the 7 new WTSFU tests); wts3d-test 118/120 (the two CRLF checks fail on the LF checkout, as expected); `wts-calc-golden.js --check --time` green;
perf A/A as above.

**WP-E0 review fixes (lead, branch `sim-fu-found` from `sim-fu-e0`).**
- Hook sites added, all behind their guards and listed in the WP-E2 section header of 31: `cushHeater(N.heater)` (refresh,
  after the heater duty / T lines, before `hydOf`), `cushTsep(T)` (`algebraic()`, where `X.Tsep` is formed), `cushBatch(b, w)`
  (`recordBatch`, behind `cushHas`), `bypFlareQ(qFl)` (refresh, behind `bypLine`) and `bypVentHist(q)` (`histSample`, behind
  `ventOn`). §6.2 / §6.3 name them; E2 fills the bodies (the ventOn relief out of `qgFlare` / `N.flare.qMMscfd` is E2's).
- `RIG_TXT.separator` for 'flare' is the v3.3.1 text again ("bypassed (well stream to the flare / burner)"); `_wts-fu-shapes`
  `RIG_TXT_SEPARATOR.flare` follows. wts-fu-identity (1) gains mid-run `setRigup` scenarios (V-101 out / in, H-101 out / in,
  V-101 + FS-401 out) that compare the log and the `'rigup'` event payloads with v3.3.1, and a CK-102 in-then-out run that
  checks its two log / event texts and that every other log entry is v3.3.1's (the trajectory is not ===: like any effective
  rig-up change, CK-102 entering re-derives with a bumpless controller re-initialisation).
- `BYPASS_DEST` is logged only when the destination changes, not on a line-pressure change (§3.3; pinned in wts-fu-foundation).
- Legacy V-101-out path: `N.flare.P` / `Pline` show `bypF0` (§6.2), pinned in wts-fu-foundation.
- Recorded departures (code kept, plan amended): `X.ck2dP` starts at `CK2.dPss` in 'steady' mode (§3.3), and the lag is
  measured from the CK-102 outlet Phi (§5.3).
- `COUNT_SITES` re-recorded on the post-E0 tree: 67 entries — 27 done by WP-E0 (24 of WP0's plus 3 new 11-character checks
  of the v1.5.0 tests), 4 done at WP0, 8 open for WP-3D, 26 not rig counts, 2 frozen copies. Sites E0 took out of the grep
  keep their entry at the line of the changed check. wts-equipment (both in, DS-101 round trip) and wts3d-test (default sig)
  now derive the signature from `RIG_KEYS` / `RIG_DEFAULTS`.

---

## Review notes (revision 2, 2026-11-06)
The plan review raised 39 issues (3 blockers, 20 majors, 16 minors). All were taken; none was rejected. Where an issue offered
two fixes, the one chosen is named. R-numbers follow the order of the review list.

| # | Sev. | Issue | Resolution (where) |
|---|---|---|---|
| R1 | blocker | Cushion water target had a stray 5.615 (ft³ vs bbl/s), 5.6 × too much water | Targets in bbl/s (`qNow/86400`), ft³ only in velocity / mixture terms; unit test `cum.waterIn` 62.5 bbl after 1 h (§6.3, §6.4, §9.2) |
| R2, R29 | blocker / major | Blend's cushion term over-counted ≈ 10.4 bbl (60.4 bbl for a 50 bbl cushion); phase rule undefined | Blend on the formation streams only; all post-breakthrough cushion water is the volume-balanced tail, with the lag's in-flight volume subtracted; phase rule w < 0.95 → breakthrough, then tail, done at 0.999·V; test ∫ = V to 0.1 % at 10τ (D6, §6.3, §9.2) |
| R3 | major | Per-stage 150 °F J-T cap made CK-102 cool a dry gas about 49 °F more | Cumulative cap from the CK-101 inlet in the host walk and the engine; dry-gas anchor; isenthalpic per stage is C later (D10, §4.3-6, §4.6, §5.3) |
| R4 | major | qLcap used only the CK-101 ΔP with the series equivalent bean | Whole drop `X.PB − Ph − SS[2].dP·fi²` when CK-102 is active; test 128/64 within 1 % (§6.3) |
| R5 | major | Column law from the steady flowing WHP stalled wells that would unload | `WHPcol = SIT − (SIT − Pwh_ss)·fUnload − head` (ASSUMPTION); D7, §6.4 and the NOLIFT case re-anchored (D6, §6.3) |
| R6 | major | Steady wJT (0.56) cooled the mostly-liquid unload stream about 20 × too much | `wJTc` from the gas / liquid heat-capacity shares, blended with w; tests for no HYD while unloading / HYD at breakthrough (D8, §6.3) |
| R7 | major | No blocked-in protection between the chokes | Design pressure 1,440 psig (ASSUMPTION), host blocked-in check on SITHP, engine `PAH_CK2` from live Pm, text by position (D16, §4.3-8, §4.5, §5.5) |
| R8 | major | No protection of the spread with V-101 + FS-401 out to a line | NRV-501 / XV-501 labels, PSHH-104 trips SDV-101, `SEPBY_RATING`, shut-in held by the NRV; blocked outlet a stated limitation (D16, §2, §6.2, §8) |
| R9 | major | `CUSH_BURNER` silent for oil / diesel | Raised for any cushion liquid to the burner; `burnerSG` only picks the text; SG 0.85 test (§6.3) |
| R10 | major | Resizing `Cv_w` mid-run hid the separator constraint | `Cv_w` fixed; start warning and `CUSH_DUMP`; LAH / LSHH act (D8, §6.3) |
| R11 | major | Duty max() and no heater rating | Additive duty, cap 1.25 × duty_ss (ASSUMPTION), lower outlet T and `HTR_FULL`; time-basis check (D8, §6.3) |
| R12, R27 | major | Two-stage solve circular, no no-flow guard, Qg = 0, 32/64 row infeasible, no rate parameter, no cost budget | `o.qs` rate scale, outer fixed point (8 iterations), No-Flow guard, feasible-bracket Illinois solve for `QmaxPair`, Qg ≤ 0 skip, 1.01 margin, psia for Thyd, limiter incl. 'both'; 32/64 row withdrawn; `calcWTS` timing gate (§4.2-4.3, §4.6, §10) |
| R13 | major | fg² scaling dropped the liquid line loss during the cushion | Mixture-rate fraction `cushFm` while the cushion flows; seg-5 geometry and no riser stated as ASSUMPTIONS (§6.2, §1.2) |
| R14 | minor | Tbath does not exist; midcoil μJT optimism | Cap Tho − 25 °F; 50 / 50 and linear μJT marked conservative ASSUMPTIONS (§4.3-6, D10) |
| R15 | minor | Alarm texts / base regime / limiter default | "open CK-102 or reduce the rate"; `chk.regimeBase`; limiter 'both'; CK1_SUBCRIT says "not simulated" (§5.5, §4.5) |
| R16 | minor | Breakthrough from the target rate vs the lagged delivered rate | Vprod integrates the delivered cushion state; te with one Newton step on the lag; massErr on delivered rates (§6.3) |
| R17 | minor | WHP target lost noise / drawdown, stepped at the end, stall rates unclear | Noise kept, blend to the normal law with w, `tFlow` reset at tBreak, stall: all well rates 0, noise not applied, draws unchanged (§6.3) |
| R18 | minor | `wts_sepByP` 0 turned into 150; no No-Flow warning | `isFinite` clamp pattern; No-Flow warning on the sepBy walk (§4.1, §4.5) |
| R19 | minor | PCV setpoint used as burner-line back pressure | `cfg.sep.bypass.P_flare_psig` (default 5, identity asserted) (D3, §6.1-6.2, Q20) |
| R20 | minor | Relief with FS-401 out still counted as flare | `vent` sink with its own total, `massErr` extended; tanks not forced out (§3.2, §6.2, Q22) |
| R21 | blocker | Help tests turn red; Q18 impossible; afterSim appears at once | Minimal WP-HC is M and gates WP-I, owns the two Help tests; feature keys fixed together (D14, D18, §11, Q18) |
| R22 | major | Lag and cushion state lost on every `derive()` | `X.ck2dP` double and closure `cushS` / `cushOn`; derive-survival tests (D5, D11, §3.3, §5.3, §6.3) |
| R23 | major | Destination change via `setFlow` never re-normalised the rig-up | Shared `rigRenorm()` on `setRigNow` / `setConfig` / `applyFlow`; `setFlow` test (D4, §3.3, §7.2) |
| R24 | major | 38 `rigup` handler calling `calcWTS` was re-entrant and stateful | Display-only `wtsRenderResults(flow, rig)`; `calcWTS` never reads the rig-up (D2, §3.4, §4.5, §8.3) |
| R25 | major | Surge clamp and new warnings moved base fields | New warnings in `flow.ck2.warnings` / `flow.sepBy.warnings`; `flow.sepBy.surgeP_psig`; `BASE_FIELDS` listed (D2, §4.4-4.5, §9.2) |
| R26 | major | `SAMPLE_FLOW` vs host flow in wts3d-test; identity only on `SAMPLE_FLOW` | Named "fu-blocks" allowance; second identity case on a host default flow; U6 / Release row corrected (D13, §9.1-9.2) |
| R28 | major | E1 / E2 edited the same derive / refresh lines | E0 `pickSteadyBlock()`, refresh / history hooks, `ck2Info()` accessor (D15, §5.2, §12.1) |
| R30 | major | `wts-host-patch.js --check` done markers | Every marker kept once (`wtsEqChk` unchanged, `wtsEqChkS` wrapper); WP-C owns marker updates; `--check` in the WP-C gate (§4.1, §8.2, §12) |
| R31 | minor | 3D rebuild key and 9-character rigSig | Key includes the destination with V-101 out; grey state per frame; literals listed (§8.1, §3.6) |
| R32 | minor | Incomplete count inventory | Grep rule in WP-E0, `COUNT_SITES` in the fixture, signatures derived from `SIG_DEFAULT` (§3.6) |
| R33 | minor | `readPrefs` drops the cushion block; `inputsDiff` silent | Validated `cushion` block; four `inputsDiff` entries (§3.4) |
| R35 | minor | History keys and `X.cush` on the hot path | Closure `cushS`; constant number writes; in the perf A/A and gate (§6.3, §10) |
| R36 | minor | Golden from the unmerged branch, storage-dependent, tolerance vs bit-identical | Literal input sets, storage cleared, strict `===` (D13, §9.2) |
| R37 | minor | Static vs live 2D unclear | Static diagram stays v3.3.1; only the live 2D draws CK-102; WP-2D no longer depends on WP-C (§8.2, §12.1) |
| R38 | minor | Help branch conflicts in smoke / iOS CSS; stale counts | `Dev` merged into `sim-fu` before WP-L; CSS rule in its own block after Help; counts from the merged tree (§12.4-12.5) |
| R39 | minor | `flow.sepBy` P0 vs engine `pDown()` P0 | `flow.sepBy.P0_psig` published and used by `pDown()` (D3, §6.2) |
| R34 | minor | `wts_bypass_*` / `flow.byp` naming and label drift | Renamed to `sepBy` (`wts_sepByDest`, `wts_sepByP`, `flow.sepBy`, `snap.sepBy`); one label per item in `LABELS` (D17) |

---

## Appendix C — WP-I part 1 and WP-HC notes (lead, 2026-11-07, worktree `simfu/wt-rel`, branch `sim-fu`)

**Merges** (all `--no-ff`, in this order): `dev-87qwkg` (v3.3.2 Help; no conflicts, sim-fu had touched no host or Help
file), `sf/wp-c-fix`, `sf/wp-e1-fix`, `sf/wp-e2-fix`, `sf/wp-3d-fix`, `sf/wp-l-fix`, `sf/wp-2d-fix`. After each: accept
`--sources --integration --grep WTS`, `wts3d-test.js` (only the two CRLF checks fail on the LF checkout), `wts-calc-golden.js
--check --time` (BASE_FIELDS and page strictly equal; ratios 2.36–2.49 / 2.08–2.45, gates 4 / 6) and `wts-sim-perf.js` (all
cases; default 1.000–1.010 / pooled 0.998–1.024 ≤ 1.05, both 1.44–1.47 ≤ 1.6, ck2 0.98–1.01 ≤ 1.10, cushion 1.09–1.10 ≤ 1.15
from WP-E2 on, line 0.89–0.93 ≤ 1.05). The only red test between the merges was the Help page's today-variant check (the
engine ships `features` since WP-E0), fixed in WP-HC.

**Conflicts.** `tests/wts-heater-choke.test.js` (C / E1), `tests/wts-bypass-cushion.test.js` (C / E2) and
`tests/wts-fu-views.test.js` (L / 2D) were added on both branches: each kept both groups (`HOST.concat(ENGINE)`;
`[].concat(L, D2)` with the 2D group in its own function scope). `ios-styles.css`: the Help centre's section 8 stays, the
WP-L cushion-form block follows as section 9.

**Lead items.** Fixture `WARN_TEXTS.ck2HydrateIn` (the §4.3-7 second hydrate check added in the WP-C review); plan text
corrected as built (§8.1, §8.2, §8.3, §9.1, §9.2); WP-C's edit of the lead file `wts-fu-identity.test.js` reviewed and kept.

**WP-HC** (minimal and full parts of §11). The wts guide stays under its 14 kB serialised cap only because older parts were
tightened; the per-file caps moved 4.3 kB of unused headroom to welltest, simcourse and the manifest module (sum 345 kB). FS-1 /
FS-2 `afterSim` are the main texts and `today` a short note; the course test checks `afterSim` references and bold text when
the engine has the feature, and the search index uses the variant shown. Live checks: FS-1 cushion to the burner (CUSH_BURNER,
WHP target 1,700, breakthrough 2,468 s after the start, done ≈ 3.2 h, 50 bbl), through V-101 (CUSH_DUMP, LAHH-101, carry-over),
12/64 (CUSH_LIMIT, ≈ 1,200 bbl/d); FS-2 line 300 (choke outlet 308 psig, FS-401 out, vent) and the subcritical example;
exercise 11 (ANCHORS_CK2, live Pm ≈ 2,460 psig on 32/64 at the cut rate). Three new screenshots (ex11 card and 2D, FS-1 cushion).

**Browser check (§9.3)**: Chromium with software GL on the built page, desktop 1440 × 900 in 2D and 3D and a phone at 390 px:
CK-102 32/64 (CHOKE2_LIMIT, CK1_SUBCRIT, PAH_CK2; CK-101 outlet = Pm + seg-3 loss), heater bypass (CK-102 bypassed, alarms
released), V-101 out → line 300 (CK-102 outlet 307 psig) → FS-401 out (vent, To production line) → back to flare (FS-401 forced
back in), cushion start → breakthrough → done (49.97 bbl, mass balance < 1e-14), one `wts:calc` per calc, none on a rig-up
change, Project New; no NaN, no console errors (45 checks).

**Open after part 1.** The SEPBY_RATING text rounds a small line loss to "0 psi" at 1,440 psig (it quotes the seg-5 dP
only); after `done` the cushion tail runs on, so CUSH_BURNER stays until the formation blend ends (E2 note (2)); release items
of §13 (version, RELEASE_NOTES, README, CLAUDE.md limitations and stats, PROJECT-NOTES) are WP-I part 2.
