# Simulator equipment: second surge tank T-202 and cyclonic desander DS-101 — implementation plan

> **Status: plan, reviewed** (2026-11-01). Target: the next point release after the `RELEASE_NOTES[0].ver` current at
> integration (**v3.3.1 provisional**; the number is fixed at WP-I, §11). No code has been written. This file is the only
> repository file changed by the planning step. The owner's request (user feedback with a screenshot): *"add equipment like 2
> surge tanks, I also noticed you can't add cyclonic de sander. Do this — desander should be upstream of choke."* Equipment,
> methods and standards are named generically, by standard designation or by correlation author only; no other company,
> product, vendor or website is named. The review findings and what changed for each are in Appendix B.

| | |
|---|---|
| Release | **Next point release (v3.3.1 provisional)**. One increment, no feature flag: both items are optional rig-up items, **out by default**. With both out and no sand, the engine results, the 3D scene and the 2D schematic are those of v3.3 (D1 lists exactly what every user still sees change) |
| What | (1) **DS-101 cyclonic wellhead desander** between SDV-101 and CK-101 (upstream of the choke), with sand in the well stream, grade-efficiency capture, ΔP, an interlocked accumulator dump sequence, bypass line-up, sand carried to the choke and on to the separator, and a steel-equivalent choke erosion indicator. (2) **T-202 second surge tank**: a separate pressurised vessel in parallel with T-201, own gas space, check-valved inlet branch with a pressure-driven split, back-pressure valve, blanket, relief valve, level alarms, inlet valve and pressure-driven transfer valve to the shared gauge tank |
| Where | Well Test Simulator, Round 7: engine `prism-build/31-wts-sim.js`, 3D scene `prism-build/32-wts-3d.js`, live controller / HMI `prism-build/38-wts-live.js`; host `well-testing-app.html` (2D schematic `wtsDrawDiag`, Dynamic Simulation inputs, release notes); test harness `prism-build/tests/_harness.js` (Round 7 added to the in-memory pipeline, WP0) |
| Not touched | PRiSM, calculators, Modbus station and Mini WellOS levels panel (follow-up, §1.2), the host steady calculation `calcWTS` (beyond seven new inputs passed into `flow.sim`) |
| Inputs | Session notes `simeq/audit-engine.md` (engine audit, line numbers of 31), `simeq/audit-views.md` (3D, 2D, HMI, tests), `simeq/research.md` (engineering basis: hydrocyclone grade efficiency and cut size, ΔP, accumulator and dump practice, DNV-RP-O501 erosion, surge-tank practice, alarms), `simeq/anchors.js` and `simeq/anchors-rev.js` (worked numbers of §4.9), `simeq/review-calc.js`, `simeq/perf-noise.js`. This plan copies everything a builder needs |

**Conventions.** Field units throughout: psi / psig / psia, °F, ft, ft/s, lb, lb/ft³, lb/d, bbl, bbl/d, gal, Mscf/d, MMscf/d,
cP, µm (particle size only), mpy (mils per year) and mil/d (steel-equivalent erosion rate), mil (metal loss). Engine time is
seconds (as today). "ASSUMPTION" marks a modelling choice with no published correlation behind it (research.md labels). Line
numbers are for the v3.3 tree at `666be77` (`31-wts-sim.js` 2,736 lines, `32-wts-3d.js` 4,036, `38-wts-live.js` 3,370).
"Out of the rig-up" for an optional item means **absent and hidden**, not ghosted. MoSCoW tags: **M** must, **S** should (drop
only with the lead's agreement), **C** could. **Code style:** the Round-7 sources are ES5 (`var`, `function`; no `let` /
`const` in 31/32, no `??`, `?.` or `=>` anywhere); pseudo-code in this plan is written the same way and builders keep it so.

---

## 0. Decisions at a glance

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Default state | Both items are **optional rig-up items, out by default** (`optional:true, def:false`). With both out and sand 0: engine results identical to v3.3 (checked against a frozen copy of the v3.3 engine, §7), 3D scene identical (optional tables filtered by the rig-up, §8.1), 2D schematic identical (each schematic row has a legacy variant drawn while its new item is out, §8.2). **What every user still sees change:** seven new Dynamic Simulation inputs (they also appear in the page report's Inputs), eight new Scenarios entries after the v3.3 ones, two new Rig-up switches (their rows are `rp-skip` while out, so the report rows stay as in v3.3) | The default spread, `SAMPLE_FLOW`, the balance tests, Mini WellOS and every saved v3.3 rig-up and project file keep their numbers and pictures; the per-substep budget is already at the edge (§7). The release note says what changes |
| D2 | Backward compatibility of the rig-up request | A **missing** key takes the item's default (core = in, optional = out); an optional item is in only when its value is strictly `true` | Today a missing key means "in" (normRigup, setRigReq, getRigup, setRigNow(null), 38 applyFlow / fullRig / renderRig, 32 rigSigOf). Without D2 every old `wts_sim_rigup` and project file would suddenly carry T-202 and DS-101 |
| D3 | Signature and `full` | `sig` grows to 10 characters by **appending** `desander`, `surge2` (default `'1111111100'`); `full` = all **core** items in; new `extras` = optional items in | `setRigNow` re-derives only when the sig changes, so the new keys must be in it; the first 8 characters keep their meaning; `full` assertions and "(full rig-up)" texts stay right |
| D4 | Desander position and pressure class | DS-101 sits inside segment 1 (`esd_choke`): WH-101 → SDV-101 → **DS-101** → CK-101. SDV-101 stays nearest the well and also isolates the desander. DS-101 must match the flowhead / SDV-101 pressure class and be rated for the **maximum shut-in wellhead pressure** (new input, estimated as 1.2 × flowing WHP when blank; an entered value is also the wellhead's shut-in build-up target, review fix), so it has no PSV. A rating below it, or a well temperature outside the rating's temperature class, is a design **alarm** (`DES_RATING`); the desander inlet at or above 0.95 × the rating with SDV-101 open trips the ESD (**PSHH-103**, the one desander trip) | Owner requirement (upstream of the choke); protects the bean and everything downstream. The engine never shows the desander SITHP dynamically (its only shut-in, SDV-101, is upstream of it), so the design check and PSHH-103 are the protection that the "no PSV" argument relies on |
| D5 | Desander physics | ΔP = K·ρmix·v_in²/9266 (velocity head, K 6); cut size d50c from a Plitt / Stokes velocity law with turndown, re-entrainment and high-GVF factors; carrier = blended liquid, or gas (Lee-Gonzalez-Eakin viscosity) for a well with no liquid; capture = log-normal PSD integrated over the Plitt grade-efficiency curve (m = 2) through precomputed tables, one for formation sand and one for flow-back proppant, weighted by mass; efficiency falls to 0 between 90 % and 100 % accumulator fill | research.md §1.3–1.7; table lookup keeps the substep cheap; the gas carrier keeps a dry-gas well finite |
| D6 | Sand in the well stream | Inputs sand rate (lb per 1,000 bbl liquid, and lb/MMscf for gas), median size and spread. **Default 0** in the engine and in the host form. A **"Sand / proppant flow-back"** scenario (200 lb/h decaying with τ 6 h, proppant size 400 µm, σg 1.5, scaled by the choke opening) is the one-click demo; the DS-101 card says how to add sand when there is none | A non-zero default would add alarms and numbers to every existing user's default spread. With 0, v3.3 projects open unchanged |
| D7 | Dump | Operator **"Dump sand"** (card, 3D valve, 2D glyph, phone inset) runs the published sequence isolate → bleed → flush → equalise → reopen (8 + ≥ 300 + 600 + ≥ 120 + 8 s) with a scalar accumulator pressure and the two interlocks: flush (XV-103 open) only once the accumulator is bled below 50 psig, reopen only within 75 psi of the desander pressure. An ESD trip mid-dump **holds** the sequence (XV-103 and the bleed shut, accumulator isolated) until the operator resumes or aborts after the ESD reset. The well keeps flowing; sand caught meanwhile goes to the 20 gal upper buffer. Optional auto-dump at LAH (blocked after a failed dump). Bleed gas and flush water are visual only (not in the balances) | Realistic practice (research §1.7) without a shut-in; the interlocks are what make dumping a wellhead-pressure vessel to an atmospheric skip safe, and the hazardous failure (passing upper isolation) can be shown |
| D8 | Bypass | Bypass is a **line-up**: HV-104 open, desander inlet and outlet blocks shut (logged): ΔP 0, no capture, all sand to the choke; the desander stays pressurised until bled. Fault: HV-104 passing (10 % of the stream and sand bypass the desander) | Operating practice: bypass only for maintenance or once sand-free; a passing bypass is the common field failure (research §3) |
| D9 | Choke erosion indicator | Sand reaching the choke (lb/d) and a **steel-equivalent erosion rate** (DNV-RP-O501 reducer model as a bean proxy) with the particle-size factor of the sand that actually reaches the bean (inlet PSD with DS-101 out, the fine tail it passes when in) and the gas expanded to the throat pressure; banded in **mil/d** against a 125 mil allowance over a 72 h test (OK < 2.08, warn < 20.8, high ≥ 20.8 mil/d), mpy as a secondary value, plus the cumulative loss. **No feedback** on the bean size or the rate | Verified equations (research §1.9, example reproduced to 0.1 %); hardened-trim constants are not verified, so the figure compares cases and is labelled screening |
| D10 | Choke capacity coupling (S) | When DS-101 is in, the inflow is scaled by local copies: critical gas flow by choke capacity ∝ P1 abs, liquid / subcritical flow by √ΔP; smooth minimum and 1 % hysteresis on `flowLimited`. Gated on `rDes` | A plugged desander can starve the choke on a liquid well or near the choke limit; on the default gas sample it needs ≈ 200 psi of desander ΔP before it acts. The legacy path stays bit-identical |
| D11 | T-202 topology | A **separate single-compartment vessel** in parallel with T-201; T-201 keeps its A \| B compartments unchanged. T-202 is allowed only with T-201 in the rig-up | The owner asked for two surge tanks; independent gas spaces are the common field layout (research §2.3 b). `rSurge` is the LCV-201 / text / routing switch in ≈ 40 places, so a stand-alone T-202 would mean generalising that whole layer |
| D12 | T-202 equipment and tags | Inlet XV-202 (with an inlet check valve), back-pressure valve **PCV-203**, blanket **PCV-204**, relief PSV-202, level gauge LG-202, transfer **LCV-202**, alarms LSHH/LSLL-202, PAH/PSHH-202, LAH-202 | PCV-202 is already T-201's blanket valve; everything else follows loop 202 |
| D13 | T-202 transfer | Its **own** on/off level-controlled LCV-202 (q = Cv·√(ΔP/SG) on T-202 pressure) into the same transfer line to T-301 (or export without T-301). No cross-vessel suction selection | Two vessels at different pressures on one suction header would back-flow; a copy of the LCV-201 law is the smallest correct change |
| D14 | Inlet manifold | Route modes **T-201 / T-202 / both** (make-before-break). Each vessel branch has a **check valve** and a conductance; with both open the dumps split **by pressure** (header pressure solved from Σq = q_dump; a branch whose vessel is at or above the header pressure carries nothing), then by XV-201A/B position inside T-201. With XV-202 shut the legacy code runs untouched | The vessels have separate gas spaces joined through the manifold; flow must go preferentially to the lower-pressure vessel and never back-flow (the same reason D13 rejects a shared outlet header) |
| D15 | Engine code structure | T-201 code paths untouched; T-202 uses a second hot object `X2` and its own functions in a new section; every per-substep block guarded by `if (rSurge2)` / `if (rDes)` / `if (sandOn)` | Bit-identical legacy results, checked exactly against a frozen copy of the v3.3 engine run side by side (§7), and no measurable cost in the default run |
| D16 | Snapshot shape | Additive: `snap.desander`, `snap.sand`, `snap.surge2`, `nodes.desander`, `nodes.surge2`, six new `lines`, five new `HIST_KEYS`, eight new faults, `rigup.desander/surge2/extras`. **`snap.segs` stays 6**; node lists only append (desander = index 8, T-202 = index 9) | Positional readers (engine derive, 38 liveNodes/liveSegs, host wtsDrawDiag, WTS_state.nodes, Pipe Service Life import, Modbus station, 3D ROUTES) keep working |
| D17 | Step numbers | One pure source: `WTS_sim.stepFor(rig)` (31) numbers the equipment in process order, counting core items always and optional items only when in; 32 and 38 call it and keep their `STEP` table as the fallback. The default rig-up gives today's ①–⑨ exactly | No renumbering for users without the new items; no drift between two copies; the `STEP` pins in wts3d-test stay valid |
| D18 | Views of optional items | Hidden when out (no ghost, no amber chip, no 2D mask, no picking / occlusion / framing / label / tracer / tap volume, the line drawn straight). Every table the views read is filtered by the effective rig-up. Core items keep the ghost pattern | Two permanent ghosts in the default scene would be noise; an invisible box that still picks, occludes or frames is a bug |
| D19 | Work split | WP0 (lead: contract fixture, frozen v3.3 engine, Round 7 in the test harness, perf script) → WP-E0 (foundation: 31 rig-up / constants / contract / stub sections and hooks **and** the 38 foundation) → WP-E1 (desander) ∥ WP-E2 (T-202) in separate sections of 31; views (WP-3D, WP-L, WP-2D) in parallel against the frozen fixture and the 38 foundation. Everything integrates on a feature branch `sim-equip`, merged to `Dev` only at WP-I | Engine is the critical path; stub sections and hooks keep the two engine branches out of each other's lines; nothing half-built reaches `Dev` / `master` / Xcode Cloud |
| D20 | Versions | `WTS_sim.VERSION` 1.3.0 → **1.4.0**; `snap.v`, `getControls().v`, flow `v` stay 1 (additive). App version = next point release, fixed at WP-I | Nothing checks VERSION; the snapshot change is additive; a version lower than an already shipped one is rejected by the store (ITMS-90062) |

---

## 1. Scope and user stories

### 1.1 In scope
- Rig-up model with optional items (§3), persisted request compatible both ways with v3.3.
- Engine: sand in the well stream (formation and flow-back streams), DS-101 desander, interlocked dump sequence with ESD hold,
  bypass line-up, faults, alarms, PSHH-103, choke erosion indicator, sand carried to the separator (accounting only) (§4); T-202
  second surge tank with pressure-driven routing, gas side, transfer, alarms and trips, faults (§5).
- Views: 3D geometry and piping for both, 2D schematic variants and live overlay, HMI cards and actions, rig-up card rows, phone
  inset, trends / HUD / strip, Metric mode (§8).
- Tests (including Round 7 in the accept-test harness), GUI-sweep run job, performance gate (§7, §9). Release notes, version
  stamps, docs (§11).

### 1.2 Out of scope (deferred, with the reason)
| Item | Reason |
|---|---|
| Modbus station variables and Mini WellOS levels panel for T-202 / DS-101 | Register map is append-only and needs its own review; Mini WellOS runs the engine-default rig-up (both items out), so nothing changes there |
| Dual-pot desander (continuous dumping), debris catcher upstream | Single accumulator with a buffer covers the clean-up case (buffer endurance ≈ 1.3 h at 200 lb/h) |
| Acoustic sand monitor reading with detection floor (C, may be pulled in by WP-E1 if time allows) | Nice realism, not needed to show the desander working |
| Bean wash-out feeding back into rate / WHP | Needs hardened-trim erosion constants that are not verified; the indicator is display-only |
| Sand settling dynamics, LCV-101/102 erosion and plugging, sand in the tanks | Sand reaching V-101 is accounted (mass, bulk volume, a warning), not modelled; nothing passes beyond V-101 |
| A T-202 without T-201; T-202 with compartments; series overflow T-201 → T-202 | See D11; a single-compartment second vessel answers the request |
| Desander ΔP in the host steady walk (`calcWTS`) | The static calculation has no rig-up; the engine subtracts the ΔP dynamically |
| Fire case for PSV-202 (and PSV-201) | Not modelled in the simulator; stated on the card and in the known limitations |
| PSHH-201 closing T-201's inlets | PSHH-201 keeps its v3.3 action (ESD only) for bit-identity; PSHH-202 closes its inlet and blanket first (§5.5). Listed as a known limitation |

### 1.3 User stories (each is an acceptance item in the named test file)
| # | Story | Test |
|---|---|---|
| U1 | I add DS-101 on the Rig-up card; the 2D and 3D show it between SDV-101 and the choke, the choke inlet pressure drops by the desander ΔP while the ESD node does not move, and the DS-101 card shows ΔP, cut size and capture | `wts-desander`, `wts-equipment-views` |
| U2 | I start Scenarios → "Sand / proppant flow-back"; the accumulator fills, LAH-103 raises after ≈ 3.5 h of flow, I press "Dump sand", confirm, watch the sequence (bleed to below 50 psig, flush, equalise) and the accumulator empties while the well keeps flowing | `wts-desander`, `wts-equipment-views` |
| U3 | During flow-back I bypass DS-101 (HV-104 line-up): sand goes to the choke, `SAND_CHOKE` and the erosion band rise to high and sand builds up in V-101; back in line they fall | `wts-desander` |
| U4 | I add T-202 from the Rig-up card; it starts empty with XV-202 shut. I route the separator dumps to T-202 or to both; with both open the lower-pressure vessel takes more; T-202 fills and LCV-202 transfers it to the gauge tank on its own pressure. A saved line-up (device prefs) restores XV-202 as it was at session start | `wts-surge2`, `wts-equipment-views` |
| U5 | T-202 reaches LSHH-202: XV-202 closes **without** an ESD; with route "both" the dumps carry on into T-201, with T-202 the only route the dumps block and the separator high-high shuts the well in. PCV-203 stuck closed raises PAH-202, then PSHH-202 closes XV-202 and PCV-204 and trips the ESD | `wts-surge2` |
| U6 | A v3.3 project file or saved rig-up opens with the same spread, the same engine numbers (exactly) and the same 2D / 3D pictures as in v3.3 | `wts-equipment` (frozen-engine identity), `wts-equipment-views`, `wts3d-test` |
| U7 | On a phone I tap the desander and dump sand from the inset with a 44 px button; I open and shut XV-202 from the T-202 inset | `wts-equipment-views` |
| U8 | In Metric mode every new value converts (kg, kg/d, L, mm/y and mm/d, bar/kPa as configured) | `wts-equipment-views`, `sweep-fixes-v31` |

---

## 2. Process topology and tags

### 2.1 Flow path after the change (optional items in brackets)
```
WH-101 → SDV-101 (ESD) → [block → DS-101 desander → block ─ XV-103 dump → sand skip] → CK-101 → H-101 → V-101 ─ gas → FE-101 → PCV-101 → FS-401
                          └──────────── [HV-104 bypass] ────────────┘                             ├─ oil → LCV-102 ─┐
                                                                                                  └─ water → LCV-101 ┴→ surge inlet manifold
   surge inlet manifold ─┬→ check → XV-201A / XV-201B → T-201 (A | B, one gas space) ─ LCV-201 ─┐
                         └→ [check → XV-202 → T-202 (one compartment, own gas space) ─ LCV-202] ─┴→ T-301A|B → P-201 → export / burner
   T-201 gas → PCV-201 → flare header;  [T-202 gas → PCV-203 → flare header]
   V-101 gas → PCV-202 (blanket) → T-201;  [V-101 gas → PCV-204 (blanket) → T-202]
   PSV-201 (T-201), [PSV-202 (T-202)] → flare header
```
The T-201 branch check valve is part of the new pressure-driven split only; with XV-202 shut nothing changes for T-201.

### 2.2 New tags (append to `TAGS`; loops 103/104 and 202–204 are free)
| Key (`TAGS.*`) | Tag | Item |
|---|---|---|
| `desander` | DS-101 | Cyclonic wellhead desander (vessel + accumulator DS-101A) |
| `dsDump` | XV-103 | Accumulator dump valve (the operator-visible valve of the dump sequence) |
| `dsBypass` | HV-104 | Desander bypass valve |
| — (alarm tags) | PDAH-103 / PDAL-103, LAH-103 / LAHH-103, PSHH-103 | ΔP, accumulator level and inlet pressure alarms / trip |
| `surge2` | T-202 | Second surge tank |
| `xvSurge2` | XV-202 | T-202 inlet valve |
| `bpv2` | PCV-203 | T-202 back-pressure valve |
| `blanket2` | PCV-204 | T-202 blanket valve |
| `psvSurge2` | PSV-202 | T-202 relief valve |
| `lgSurge2` | LG-202 | T-202 level gauge |
| `xfer2` | LCV-202 | T-202 transfer valve |
| — (alarm tags) | LSHH-202, LSLL-202, PAH-202, PSHH-202, LAH-202 | T-202 alarms and trips |

`NAMES` adds `desander: 'Cyclonic Desander'`, `surge2: 'Surge Tank 2'`, `xfer2: 'T-202 Transfer Valve'`.

---

## 3. Rig-up model (exact)

### 3.1 Items
`RIG_KEYS` (signature order, **append only**):
`['esd','choke','heater','separator','surge','gauge','pump','flare','desander','surge2']`.

`RIG_ITEMS` (display order = process order; consumers look items up **by key**, never by index):
```
esd (locked) · desander · choke (locked) · heater · separator · surge · surge2 · gauge · pump · flare
{ key:'desander', tag:'DS-101', name:'Cyclonic desander (upstream of the choke)', optional:true, def:false,
  why:'Optional: removes sand from the well stream before the choke. Must be rated for the maximum shut-in wellhead pressure (no relief valve).' }
{ key:'surge2', tag:'T-202', name:'Second surge tank', optional:true, def:false, needs:'surge',
  why:'Optional: a second pressurised surge tank in parallel with T-201 (needs T-201 in the rig-up).' }
```
Core items get no new field (missing `def` = true, missing `optional` = false). New deep-frozen exports:
`WTS_sim.RIG_DEFAULTS` `{esd:true, …, flare:true, desander:false, surge2:false}`, `WTS_sim.RIG_OPTIONAL` `['desander','surge2']`
and the pure `WTS_sim.stepFor(rig)` (§3.5).

### 3.2 Normalisation (`normRigup(req)`)
```
core k:     r[k] = hasOwn(q,k) && q[k] != null ? q[k] !== false : true      (today's rule, unchanged for present keys)
optional k: r[k] = q[k] === true                                             (missing, null, strings → out)
rules (after the existing ones, in this order):
  surge2 && !surge → surge2 = false; note 'T-202 works alongside T-201, so with T-201 out of the rig-up T-202 is out too.'
  (desander has no rule; with the separator out, T-202 is covered by the existing "the tanks receive no liquid" note)
sig    = one '1'/'0' per RIG_KEYS item             (default '1111111100')
full   = every non-optional item in                (default true; today sig.indexOf('0') < 0 — change it)
extras = optional keys in, in RIG_KEYS order       (default [])
```
The same default rule replaces `q[k] !== false` in `setRigReq` (L356), `getRigup` (L2143, returns all 10 keys as booleans) and
the `null`/`undefined` restore in `setRigNow` (L2268: null → the item's default). Notes for the default spread stay empty
(`wts-rigup.test.js` L118). By D11 the effective `surge2` implies the effective `surge`.

### 3.3 `setRigNow` additions
- Note (review): switching an optional item in and straight back out at t = 0 leaves the same short rig-change transient as a
  core item does in v3.3 (heater out → in); reset clears it apart from the `alarmVersion` / `rigup.v` counters and the reset
  log entry. No change.
- `RIG_TXT.desander = [TAGS.desander, 'out of the rig-up (well stream straight to the choke)', 'in line upstream of the choke']`,
  `RIG_TXT.surge2 = [TAGS.surge2, 'out of the rig-up', 'in the rig-up (standby: XV-202 shut)']` — a missing entry throws.
- **T-202 leaving** (whenever the effective `surge2` goes true → false, including through the D11 rule):
  1. If no XV-201 inlet is open (route was T-202 only), snap XV-201A and XV-201B open (make-before-break: the rig-up change is a
     line-up made before the vessel is disconnected, as T-202 entering snaps XV-202 shut), except a compartment at LSHH-201;
     log `event` / `ROUTE` 'XV-201A/B opened: T-202 left the rig-up'. If neither compartment can open, **refuse** the change
     (`setRigup` returns false; note 'T-202 is the only open route and T-201 cannot take the dumps (LSHH-201): open a T-201 inlet
     first.'). 38 shows the note and disables T-202's switch with that reason while it applies. **Snapshot path (WP-E0
     review):** `rigup.refused` — `''`, or the note of the last refused `setRigup` while the same change would still be refused
     (re-checked through the `check` hooks on every refresh while a refusal is stored; cleared by the next accepted change).
     The refusal is also logged (`event` / `RIGUP`) and emitted as an `'event'`; views read only `rigup.refused`.
  2. Release the latched act alarms explicitly (`quiet()` skips alarms with `act`): `XFER2_DRYRUN`, `LSHH_SURGE2`.
  3. `quiet(Q_SURGE2)` once (§5.5), so a `PSHH_SURGE2` / `LSHH_SURGE2` active at removal can never block the ESD reset.
- **DS-101 leaving**: abort a running or held dump (phase → idle; the buffer moves into the accumulator by the capped rule of
  §4.4; `logEntry('event','DS_DUMP', …,'dump aborted: DS-101 out of the rig-up')`), `quiet(Q_DES)`; `X.PD = 0` and the legacy
  PB law takes over from **`X.PB = X.PBu`** (§4.3). **WP-I decision:** the ESD node is continuous (§6.4), so the single legacy
  node carries the pressure upstream of DS-101 over and keeps its 5 s lag; the choke inlet loses the desander ΔP with the
  bypass spool (a rig-up change is an instantaneous line-up, as T-202's snaps). Taking over from the choke inlet (`PBu − PD`, the
  WP-E1 behaviour) would have stepped the ESD node down by ΔP. `wts-desander` asserts both nodes = the old PBu after the
  rig-out and no ESD-node step in the next second.
- **DS-101 entering**: `X.PBu = X.PB`, `X.PD = 0`, `P_acc = X.PB`, phase idle.
- **T-202 entering from the card**: command XV-202 shut (position snaps to 0); its inventory is whatever it held (empty after
  `create`/`reset`). **Precedence:** device prefs (`h2viz3d_prefs.ctl.surge2`) restore the saved line-up on session start
  (`setControls(c, {initial:true})` → `initState`), so a saved XV-202 open comes back open; only adding T-202 from the card
  snaps XV-202 shut.
- Re-derive on the sig change (existing gate). Message ends " (full rig-up)" when `full`, as today; the event payload adds `extras`.

### 3.4 Persistence and callers (38; all in the WP-E0 38 foundation)
| Where | Change |
|---|---|
| `readRig()` L774 | keeps booleans for known keys; returns null when nothing valid (unchanged) |
| `writeRig(r)` L784 | **removes the key when the request equals `RIG_DEFAULTS`**; otherwise stores all 10 keys. (Today: "no false = remove", which would drop a request with only an optional item on) |
| `applyFlow` L1222 | `all[k] = hasOwn(rq,k) ? (it.optional ? rq[k] === true : rq[k] !== false) : (it.optional ? false : true)` |
| `fullRig()` L1171 | "Full rig-up" sets every **core** item in and leaves optional items as they are (matches `rigup.full`) |
| `renderRig` L1002-1027 | `inRig` = `ru[k] === true` for optional items, `ru[k] !== false` for core; `asked` likewise from `req`. `nOut` counts **core** items only; the Full rig-up button's disabled test runs over core items only (`items.filter(!optional).every(…)`). Configuration row: 'Full rig-up' (+ ' · with DS-101 / T-202' naming the extras in) or 'n items out of the rig-up'. Optional rows: 'Not in the spread' / 'In service', switch title 'Add DS-101 to the rig-up' / 'Take DS-101 out of the rig-up'; T-202's switch disabled with the reason while T-201 is out (or while the §3.3 refusal applies). Optional rows that are **out** get class `rp-skip` (not `off`), so a default page report has exactly the v3.3 rows. 'T-202 → T-301 transfer (LCV-202)' row and the DS-101 / T-202 status rows only when in |
| `summaryOf` L341 | `out` lists core items out only; adds `extras` |
| `rigOut(st,id)` L792 | unchanged (true when `r[id] === false`); new `rigIn(st,id)` = `r[id] === true` (optional items) |
| `RIG_FALLBACK` L64 | +2 rows (with optional flag) |
| `STEP` | kept as the fallback; chips and card headers use `WTS_sim.stepFor(st.rigup)` when present |
| `_internals` L3271 | + `rigIn`, `EQV`, `stepFor`, and test hooks `sim()` (current engine) / `useSim(stub)` (recording stub for view tests) |

There is **no** `noSurge()` helper: by D11 "no surge tank at all" is exactly `rigOut(st,'surge')`, so the existing call sites stay.
Compatibility both ways: a v3.3 request (8 keys) → both new items out; a v3.3.1 request opened by v3.3 → unknown keys ignored by
its `readRig`. Device prefs `h2viz3d_prefs.ctl` with `surge2` / `desander` keys pass through v3.3's shape check and are ignored.

### 3.5 `stepFor(rig)` (31, pure, exported)
Order: `wellhead, esd, desander*, choke, heater, separator, flare, surge, surge2*, gauge, pump` (`*` counted only when
`rig[k] === true`); returns `{eqId: '①'…}` for every item counted. Default rig-up = today's `STEP` (①–⑨); DS-101 in → desander
③, choke ④, pump ⑩; T-202 in → surge2 ⑧, gauge ⑨, pump ⑩; both → pump ⑪. The four combinations are pinned in
`_wts-equip-shapes.js`.

---

## 4. Engine: sand, DS-101 desander, choke erosion (WP-E1)

### 4.1 Inputs
`DEFAULTS.sand` and `DEFAULTS.desander` (§6.2), fed from the host through `flowDerived(flow.sim)`: `sand_pptb`, `sand_lbmmscf`,
`sand_d50_um`, `desRating_psi`, `desAcc_gal`, `sithp_psig` (§6.3). `sandOn` = `sand.pptb > 0 || sand.lbPerMMscf > 0 || fault
sandFlowback`. On every `sandOn` true → false transition (in `setConfig` and `setFault`), `quiet(Q_SAND)`.

### 4.2 Steady quantities (computed in `derive()`, never per substep)
From the flow v1 segment 1 (`esd_choke`) and the fluid block. Every quantity is finite for any valid flow (including Qo = Qw = 0
and a zero velocity); `desOK = false` skips the whole desander block.
```
A_pipe   = π/4·(segs[1].ID/12)²                                     ft²
q_T      = segs[1].vel·A_pipe                                       ft³/s
if q_T ≤ 0: desOK = false; GVF = 0; v_in,ss = 0; dP_ss = 0; eff = effClean = 0; d50c,ss = d50s (display only)  → done
v_in,ss  = q_T / Ain_ft2                                             ft/s   (Ain 0.0341 ft², 2.5-in equivalent inlet)
ρmix     = segs[1].rhom                                              lb/ft³ (no-slip; host value)
dP_ss    = K_dp · ρmix · v_in,ss² / 9266.1                           psi    (K 6)
q_L      = (Qo+Qw)·5.614583/86400;  GVF = clamp(1 − q_L/q_T, 0, 1)
carrier blended by GVF (review fix): w = clamp((GVF − gvfGasLo)/(gvfGasHi − gvfGasLo), 0, 1), gvfGasLo 0.95, gvfGasHi 0.995
  (w = 1 with no liquid; with q_T = 0 the GVF is taken as 0 with liquid, 1 without); μ = (1−w)·μ_liq + w·μ_gas,
  ρc = (1−w)·ρ_liq + w·ρ_g, f_g = 1 + (1−w)·(f_g,liq − 1); snapshot carrier = 'liquid' while w < 0.5, else 'gas'. A trace of
  liquid in a dry-gas well no longer switches the cut size (it used to switch at Qo+Qw = 1e−6 bbl/d). SAMPLE_FLOW (GVF 0.890)
  has w = 0, so the anchors are unchanged.
liquid carrier terms (μ_liq, ρ_liq, f_g,liq):
  wc     = Qw/(Qo+Qw)
  μo     = 10^(10^(3.0324 − 0.02023·API) · T^−1.163) − 1            cP     (dead-oil, T = desander T in °F; conservative)
  μw     = exp(1.003 − 1.479e−2·T + 1.982e−5·T²)                     cP
  μ      = (1−wc)·μo + wc·μw;  ρc = (1−wc)·ρoil + wc·ρwat;  Δρ = ρs − ρc (ρs 165.4)
  f_g    = 1 + gvfGain·max(0,(GVF − gvfKnee)/(1 − gvfKnee))²         ASSUMPTION (≤ 1.5 at GVF → 1)
gas carrier terms (μ_gas, ρ_g):
  wc = 0;  μ = μg(P_des, T_des) by Lee-Gonzalez-Eakin (local pure copy `muGasLGE(SGg, T_F, Z, P_psia)` in 31 — the engine loads
  stand-alone, so it does not call 16-pvt.js; same formula as `mu_g_leeGonzalezEakin`);  ρc = ρg = P·Mg/(Z·10.7316·T_R);
  Δρ = ρs − ρg;  f_g = 1
d50c,ss  = d50ref·√((μ/μref)·(Δρref/Δρ)·(vref/v_in,ss)) · f_g        µm     (25 µm at 30 ft/s, 1 cP, Δρ 103)
tables, x_i = log10(d50c/d50) from −3 to +2 step 0.05 (101 points), for each stream s ∈ {res (formation: d50_um, sigmaG),
           fb (flow-back: flowback.d50_um, flowback.sigmaG)} with d_k = d50·σg^z_k, w_k = exp(−z_k²/2), z_k = −4…+4 in 64 steps:
  Etab_s[i]  = Σ w_k·E(d_k) / Σ w_k,          E(d) = 1 − exp(−0.693147·(d/d50c)^m)   (closed accumulator: no bypass fraction)
  C2p_s[i]   = Σ w_k(1−E_k)·C2(d_k) / Σ w_k(1−E_k)      (particle-size factor of the sand the cyclone passes)
  C2in_s     = Σ w_k·C2(d_k) / Σ w_k                    (inlet, mass-weighted);  C2(d) = min(1, d/(30·√ρm,SI)), ρm,SI = ρmix·16.0185
cap_lb   = acc_gal·0.133681·ρs·(1−φ);  bufCap_lb = buf_gal·0.133681·ρs·(1−φ)   (50 gal → 663 lb; 20 gal → 265 lb)
SITHP    = desander.sithp_psig if set (input), else ramp.sithpFactor·Pwh_ss with sithpEst = true          psig
ratingOK = rating_psi ≥ SITHP (gauge against gauge);  tempOK = tempMin_F ≤ FWHT ≤ tempMax_F[rating]
Ured,ss  = segs[1].vel·(segs[1].ID/(bean/64))²                       ft/s  (upstream-density continuity at the bean)
throat   = Pt = P1a·rCrit (chk.regime 'Critical') else the choke outlet pressure abs;  φt = (P1a/Pt)·(Zt/Z1)  (isothermal: conservative)
v_t,ss   = Ured,ss·((1 − GVF) + GVF·φt);  GVF_t = GVF·φt/((1 − GVF) + GVF·φt)
c_mix,t  = homogeneous-mixture speed of sound at Pt: 1/(ρm·c²) = Σ αi/(ρi·ci²), gas term from ρg(Pt) and c_g = √(k·Z·R·T/M),
           liquid term (c_L 4,000 ft/s) added only when (1 − GVF_t) > 0
Up,ss    = min(v_t,ss, c_mix,t)
eroCoef' = DNV-RP-O501 reducer model for 1 lb/d at Up = 1 ft/s and C2 = 1 (steel K 2.0e−9, n 2.6, ρt 7,800 kg/m³, α 60°,
           D1 = seg-1 ID, D2 = bean), so that rate_mpy = eroCoef'·W_choke·Up^2.6·C2 (§4.7)
PDAH expected-ΔP basis = dP_ss (scaled per substep by fInst²)
```
Pure helpers exported for tests: `WTS_sim.sand = { etot, cut, dp, erosionReducer, muDeadOil, muGas, c2, mixSound }` (no state).
`derive()` clamps the `cfg.sand` / `cfg.desander` / `cfg.surge2` values it reads to the §6.3 ranges (covers `setConfig`, project
files and Mini WellOS as well as the host).

### 4.3 Per substep (only when `rDes` or `sandOn`; nothing runs in the default spread)
```
flowing   = fEn > 0.01 && desOK
fI        = max(fInst, 1e-3)
v_in      = max(v_in,ss·fInst, 0.1)                                                            ft/s
fill      = acc/cap, or buf/bufCap while the accumulator is isolated (dumping or held)
factor    = (plugged ? plugFactor : 1)·(washout ? washFactor : 1)·(1 + packDpGain·max(0, fill − effFillKnee))·(bpPassing ? 0.81 : 1)
PDraw     = (rDes && !bypass && flowing) ? dP_ss·fInst²·factor : 0                              psi
X.PD     += (PDraw − X.PD)·(1 − exp(−h/5))                     (same 5 s lag as PB)
upstream  : DS-101 out → L1594-1595 unchanged (X.PB).  DS-101 in → the same law integrates X.PBu (pressure upstream of the
            desander, = ESD node), and X.PB = X.PBu − X.PD (choke inlet). A PD step moves only the choke inlet, smoothly.
if sandOn && flowing:
  Wres    = W_ss·fI^rateExp,  W_ss = pptb·(Qo+Qw)/1000 + lbPerMMscf·Qg      lb/d   rateExp 1.5 (ASSUMPTION)
  Wfb     = flowback ? 24·W0_lbph·exp(−tSand/τ)·min(1.5, fI)^rateExp : 0;  tSand += h        (3.5 h anchor at fI = 1)
  W       = Wres + Wfb
  if rDes && !bypass:
    d50c  = d50c,ss·fI^−0.5 · max(1, vMin/v_in) · (1 + 2·max(0, v_in/vMax − 1)) · (washout ? washCut : 1) · (slugging ? slugCut : 1)
    x_s   = clamp(log10(d50c/d50_s), −3, +2);  E_s = interp(Etab_s, x_s);  C2p_s = interp(C2p_s, x_s)
    g     = clamp((1 − fill)/(1 − effFillKnee), 0, 1)                                       (ASSUMPTION: 1 to 90 %, 0 at 100 %)
    a     = g·(1 − (bpPassing ? bypassLeak : 0))                                            (fraction presented to the cyclone)
    room  = max(0, cap − acc), or max(0, bufCap − buf) while isolated
    capt  = clamp((E_res·Wres + E_fb·Wfb)·a·h/86400, 0, min(room, W·h/86400))
  else capt = 0, a = 0
  pass    = W·h/86400 − capt
  C2_choke = mass-weighted C2 of what passes: Σ_s W_s·[(1−a)·C2in_s + a·(1−E_s)·C2p_s], plus any room-limited shortfall at the
             inlet C2; DS-101 out or bypassed: the inlet mix (C2in_s weighted by W_s)
  cum.sandIn += W·h/86400; cum.sandCapt += capt; cum.sandToChoke += pass;
  cum.sandToSep += pass (rSep) else cum.sandToFlare += pass;  loss_mil += rate_mild(§4.7)·h/86400
non-finite guard: every per-substep sand quantity is checked with isFinite; a non-finite value gives capt = 0, keeps the last
  finite d50c / eff, and never reaches the snapshot or the cumulative totals
not flowing: d50c / effClean show the last clean (flowing) value; eff = 0; capt = 0; W = 0 (tSand does not advance)
```
The chosen step `h` is unchanged; `chooseH` adds event location only for dump-phase ends and the two interlock crossings
(analytic: `t = τ·ln(P_acc/50)` in bleed, `t = τ·ln(|PB − P_acc|/75)` in equalise) while dumping, and the auto-dump set point
while auto is on. **No new draws from the main PRNG** (the random stream, and so every legacy number, is unchanged).

### 4.4 Accumulator, interlocks and dump sequence
State: `acc`, `buf` (lb), `P_acc` (psig, scalar, no fluid balance), `phase`, `phaseT`, `heldFrom`, `count`, `lastT`, `failed`,
`autoBlocked`.

| Phase | Duration | What happens |
|---|---|---|
| `isolate` | 8 s | upper isolation closes; `P_acc` holds; captured sand now goes to the buffer (fill for g() = buffer fill) |
| `bleed` | ≥ 300 s, until `P_acc` < 50 psig | `P_acc` decays first-order to 0 psig with τ = bleedS/4 (75 s; visual: 3D sand-skip puff, 2D dash). If still ≥ 50 psig at `bleedTimeoutS` (600 s from the bleed start): `DES_DUMP_FAIL` 'accumulator not bled — upper isolation passing?', **no flush**, go to `equalise` (nothing released). At bleed start the bleed-line hydrate check of §4.8 runs |
| `flush` | 600 s | XV-103 open; accumulator mass falls linearly to 0 into `cum.sandDumped` (with `desanderDumpStuck`: XV-103 stays shut, nothing removed, `DES_DUMP_FAIL` 'dump valve did not open' at the end) |
| `equalise` | ≥ 120 s, until \|PB − `P_acc`\| < 75 psi | `P_acc` rises first-order to PB with τ = equalS/4 (30 s) |
| `reopen` | 8 s | isolation opens, `P_acc` = PB; at the end move `min(buf, cap − acc)` into the accumulator (the rest stays in the buffer), `count++`, `lastT = t` |

- **Interlocks** (the two gates above): XV-103 may open only with the upper isolation shut and `P_acc` < 50 psig; the upper
  isolation may reopen only within 75 psi of PB.
- **Fault `desanderIsoPassing`** (upper isolation passing): while isolated, `P_acc` also relaxes toward PB with τ 30 s; with the
  75 s bleed the equilibrium is ≈ 0.71·PB (≈ 2,140 psig on the sample), so the bleed never reaches 50 psig and the dump ends with
  `DES_DUMP_FAIL` and no release.
- **ESD trip mid-dump** (any phase): XV-103 and the bleed close, `heldFrom` = the interrupted phase, phase → `held`; the
  accumulator stays isolated (`P_acc` holds), the buffer keeps collecting (nothing arrives while shut in). After the ESD reset
  the operator chooses `dumpDesander('resume')` (re-enters `heldFrom` with its elapsed time; the phase gates still apply — a dump
  held in `reopen` resumes in `equalise` with its time served, so interlock 2 is checked again before the isolation reopens) or
  `dumpDesander('abort')` (go to `equalise` → `reopen`, nothing more released). Both are refused while the ESD is tripped. Logged
  as `event` / `DS_DUMP`. Auto-dump never resumes a held dump.
- `dumpDesander(cmd)` → `{ok, msg}`, `cmd` = `'start'` (default) | `'resume'` | `'abort'`: start is refused when DS-101 is out of
  the rig-up, a dump is running or held, or the ESD is tripped. `DES_DUMP_FAIL` clears at the next manual start.
- **Auto-dump** (`auto.on`, default off) starts a dump when `acc_frac ≥ auto.sp` (default 0.80), the phase is idle, the ESD is
  not tripped and `autoBlocked` is false; it runs the same interlocked sequence. After a `DES_DUMP_FAIL`, `autoBlocked = true`
  until the alarm clears, so a failed valve cannot cycle the sequence. The card notes "auto-dump assumes an attended,
  interlocked dump system".
- **Capacity guards**: `g` ∈ [0, 1], `room` ≥ 0, `capt` ∈ [0, W·h/86400]; reopen and every abort (rig-out, `'abort'`) move only
  `min(buf, cap − acc)`. With accumulator and buffer both full, capture is 0 and `DES_LAHH` is active.
- Phase changes are logged as `event` / `DS_DUMP` and emitted as `'dump'` events. Sand balance (exact, `health.massErr.sand`):
  `cum.sandIn = cum.sandCapt + cum.sandToChoke`, `cum.sandCapt = acc + buf + cum.sandDumped`,
  `cum.sandToChoke = cum.sandToSep + cum.sandToFlare`.
- Durations on the sample (PB ≈ 2,995 psig): bleed 307 s, equalise 120 s, total ≈ **1,043 s**; at PB 10,000 psig: bleed 397 s,
  equalise 147 s.

### 4.5 Bypass, faults
- `setDesander({bypass, auto:{on, sp}})` (also through `setControls(ctl.desander)`): bypass is a **line-up** — HV-104 open,
  desander inlet and outlet blocks shut, logged (`event`, `DS_BYPASS`, 'HV-104 open, DS-101 blocked in'); PD 0, capture 0.
  Allowed during a dump (the dump continues; nothing is captured). The card says "DS-101 stays pressurised while bypassed until
  it is bled (Dump sand bleeds it)".
- Faults (append to `FAULT_IDS` / `FAULT_LABELS`): `desanderPlugged` 'DS-101 liner plugged' (ΔP × 3), `desanderWashout`
  'DS-101 liner washed out' (ΔP × 0.3, cut × 3), `desanderDumpStuck` 'XV-103 stuck closed', `desanderIsoPassing` 'DS-101 isolation
  passing' (§4.4), `desanderBypassPassing` 'HV-104 passing' (10 % of the stream and sand bypass the desander: capture × 0.9, ΔP ×
  0.81, PDAL judged on that reduced ΔP — a hidden failure seen only in the sand to the choke), `sandFlowback` 'Sand flow-back'
  (switching it on sets `tSand = 0`). Faults on equipment out of the rig-up are accepted and act when it is in.

### 4.6 Choke capacity coupling (S, gated on `rDes`)
Local scaled copies only (`qgL = qgE·s`, `qoL = qoE·s`, `qwL = qwE·s` used by the inflow law this substep; `qgE/qoE/qwE` are
`derive()` constants and are never written):
```
critical gas (chk.regime === 'Critical' && Qg > 0):  r = QmaxMMscfd·(Pci_ss − X.PD + 14.696)/(Pci_ss + 14.696) / (Qg·limFac)
otherwise (liquid well or subcritical):              r = √(max(0, 1 − X.PD/(Pci_ss − Pck_ss)))
s = 1 (r ≥ 1.02);  s = r (r ≤ 0.98);  s = (1 + r)/2 − ((r − 1)² + 0.0004)/0.08 in between     (C1-smooth minimum)
flowLimited: set when r < 0.99, cleared when r > 1.00                                            (1 % hysteresis)
```
`Qg·limFac` is the rate the inflow law carries (= Qmax when the steady calculation is already flow-limited; WP-E1, text
aligned at WP-I). `CHOKE_LIMIT` reads the dynamic flag while DS-101 is in. With DS-101 out the code path is the legacy one. The coupling only
matters on liquid wells, or with a plugged liner near the choke limit: on the default gas sample X.PD must reach ≈ 200 psi.

### 4.7 Choke erosion indicator (display only)
```
W_choke    = sand reaching the choke, lb/d (all of W when DS-101 is out or bypassed)
Up         = min(v_t,ss·fInst, c_mix,t)                                          ft/s (bean impact velocity proxy, §4.2)
rate_mpy   = eroCoef' · W_choke · Up^2.6 · C2_choke                              steel-equivalent, DNV-RP-O501 reducer model
rate_mild  = rate_mpy / 365.25                                                   mil/d (= projected loss per 24 h)
band       = 'none' (W_choke = 0) | 'ok' (< warn) | 'warn' (< high) | 'high' (≥ high), on rate_mild:
             warn = warnFrac·allowance/(testH/24) = 0.05·125/3 = 2.08 mil/d;  high = highFrac·… = 20.8 mil/d
             (ASSUMPTION: 5 % / 50 % of a 1/8-in (125 mil) steel-equivalent allowance over a 72 h test; configurable)
loss_mil   = ∫ rate_mild dt                                                      cumulative steel-equivalent metal loss
```
Label everywhere: "steel-equivalent erosion (screening) — compares cases; hardened trims wear more slowly; not a bean life".
mpy is shown as the secondary value.

### 4.8 Alarms (`eq:'desander'` unless stated; evaluated only when the item is in / sand is on; **only PSHH-103 trips the ESD**)
| id | tag | sev | condition | action / text |
|---|---|---|---|---|
| `DES_DP_HIGH` | PDAH-103 | alarm | flowing and (ΔP ≥ max(2·exp, exp + 5) with exp ≥ 2 psi, or ΔP ≥ dpAlarmHi 75 psi); exp = dP_ss·fInst²; clears below 0.9 × the threshold | 'ΔP x psi = r × clean: plugged liner, packed accumulator or over-rate' |
| `DES_DP_LOW` | PDAL-103 | warn | ΔP < 0.5 × exp, exp ≥ 2 psi, not bypassed | liner washed out: desander ineffective |
| `DES_LAH` | LAH-103 | alarm | acc_frac ≥ lah (0.80) | dump the accumulator |
| `DES_LAHH` | LAHH-103 | alarm | acc_frac ≥ lahh (0.95), or accumulator and buffer both full | capture falling, sand carried to the choke |
| `DES_DUMP_FAIL` | XV-103 | alarm | `dump.failed` | 'dump valve did not open' or 'accumulator not bled — upper isolation passing?'; auto-dump blocked |
| `DES_RATING` | DS-101 | **alarm** (design) | rating_psi < SITHP, or FWHT outside the class (−50…250 °F at 5,000 psi; −50…350 °F at 10,000 / 15,000) | 'rating below the maximum shut-in wellhead pressure; not fit for this well (no relief valve)' / 'well temperature outside the desander temperature class'; text adds '(SITHP estimated as 1.2 × WHP)' when estimated. While the SITHP is estimated and the rating is below 1.5 × the estimate, the Rig-up status row and the DS-101 card show ⚠ and 'enter the measured SITHP' (review fix; no alarm) |
| `DES_PSHH` | PSHH-103 | **trip** | DS-101 in, SDV-101 open (esdTravel > 0.01; not gated on the design flow), Pin (= X.PBu) ≥ pshhFrac (0.95) × rating_psi; clears below (pshhFrac − 0.01) × rating (review fix: margin for the 5 s SDV-101 stroke) | ESD: SDV-101 is upstream of DS-101, so the shut-in protects it. The one exception to Q19 |
| `DES_RATE` | DS-101 | warn | flowing for > startupGrace (180 s) and v_in < vMin or > vMax | 'below turndown: weak swirl' / 'over-rate: carry-over' |
| `HYD_desander` | DS-101 | hyd | outlet T < Thyd(Pin), P > 10 psig (add `'desander'` to the `hn` list, L1790) | hydrate risk at the desander |
| `HYD_dsAcc` | DS-101A | hyd | Tamb < Thyd(P_acc), P_acc > 10 psig (no-flow dead leg at ambient) | hydrate / plugging risk in the accumulator |
| `HYD_dsBleed` | XV-103 | hyd | at bleed start: T_bleed = T_des − 0.07·wJT·(PB − 50) < Thyd(64.7 psia); held to the end of the dump | 'bleed-line hydrate / ice risk: inject methanol' |
| `SAND_CHOKE` (`eq:'choke'`) | CK-101 | warn > 5 lb/d; alarm > 50 lb/d | sand reaching the choke (any rig-up, when `sandOn`) | bean / downstream erosion |
| `SAND_SEP` (`eq:'separator'`) | V-101 | warn | bulk sand volume in V-101 (`cum.sandToSep/(ρs(1−φ))`) > 10 % of the water-section volume below the water LSL | 'sand building up in V-101: jet / clean before the dumps plug' |

Quiet lists `Q_DES` (every `DES_*`, `HYD_desander`, `HYD_dsAcc`, `HYD_dsBleed`), `Q_SAND` (`SAND_CHOKE`, `SAND_SEP`).
Temperatures: `nodes.desander` warms with its own lag τ = 3 × warmTau (900 s, vessel mass) instead of the pipe's 300 s; the
outlet temperature subtracts the desander's own J-T drop `0.07·wJT·X.PD`; the accumulator node is at Tamb.

### 4.9 Worked numbers (SAMPLE_FLOW, DS-101 in; `simeq/anchors.js`, `simeq/anchors-rev.js`) — test anchors
| Quantity | Value |
|---|---|
| v_in,ss / GVF / ρmix | 20.7 ft/s / 0.890 / 14.17 lb/ft³ |
| ΔP clean (K 6), helper `dp(ρ 14.17 lb/ft³, v 20.7 ft/s)` | **3.93 psi** (liquid check `dp(55, 30)` → 32.1 psi) |
| PDAH threshold / plugged ΔP / washed-out ΔP | max(7.86, 8.93) = 8.93 psi / 11.8 psi (alarm) / 1.18 psi (< 1.97: PDAL) |
| μo / μw / μL; ρL; Δρ | 2.18 / 0.36 / 1.88 cP; 54.6 lb/ft³; 110.8 lb/ft³ |
| d50c | **39.8 µm** |
| Capture E (formation PSD 150 µm, σg 2.0, m 2) | **0.946** (research table: d50c 25 → 0.985, 40 → 0.945, 75 → 0.803) |
| Capture E (flow-back PSD 400 µm, σg 1.5) | 0.99998 |
| C2: at d50s / inlet mass-weighted / passed (formation) | 0.332 / **0.400** / **0.110** (passed-sand mass median ≈ 46 µm) |
| C2: inlet / passed (flow-back) | 0.822 / 0.230 |
| At 10 pptb: in / caught / to choke | 12.0 / 11.35 / 0.646 lb/d |
| Accumulator cap / buffer cap | 663 lb / 265 lb |
| Time to LAH: 10 pptb steady / flow-back (200 lb/h, τ 6 h, proppant PSD) | 46.7 days / **3.50 h** (3.78 h if the flow-back used the formation PSD) |
| Ured / throat Pt / φt / v_t | 518 ft/s / 1,656 psia / 1.80 / 888 ft/s |
| c_mix upstream / at throat; Up | 1,190 / 1,127 ft/s; **888 ft/s** (271 m/s) |
| Steel-equivalent erosion at 10 pptb, DS-101 out / in | **1,594 mpy = 4.36 mil/d (warn)** / **23.6 mpy = 0.065 mil/d (ok)**; ratio ≈ 68× |
| Flow-back peak (4,800 lb/d), DS-101 bypassed / in | ≈ 3,600 mil/d (high) / 0.015 mil/d (ok) |
| Dump on the sample: bleed / equalise / total | 307 s / 120 s / **1,043 s** |
| Bleed temperature on the sample | 180 − 115 = 65 °F (above the ≈ 40 °F hydrate line at 64.7 psia: no warning; Twh 120 °F → ≈ 5 °F: warning) |
| SITHP estimate / rating / temperature | 3,600 psig (1.2 × 3,000) / 10,000 psi ✓ / 180 °F ≤ 350 °F ✓ |
| DNV reducer check (3-in → 0.5-in, 60 m/s, 150 µm, 300 kg/m³, 100 lb/d) | 8.72 mm/yr (research 8.7) |

---

## 5. Engine: T-202 second surge tank (WP-E2)

### 5.1 Vessel model
Vertical cylinder, one compartment, own gas space; the T-201 equations copied onto a second hot object `X2` (field names as on
`X`: `n_u, PuA, Pu, Zu, Bu, VgU, VliqU, hU, Tu, SPeu, dSPeu, Ibpv, ubpv, ublk, pshU, pshhU, mawpU, P2aU`, plus `Ph` — the inlet
header pressure of §5.2) and closure state `uo2` (STB), `uw2` (bbl), `u2cmd` (= `ctl.surge2.inlet`), `u2pos`, `psvULift2`,
`xferOn2`, `lastQx2`, `ptrip.XFER2_DRYRUN`. New functions in the T-202 section: `algebraic2`, `bpv2Kc`, `bpv2Bias`, `xferDP2`,
`surge2Split`, `surge2Step(h)`, `surge2Alarms()`, `surge2Refresh(s)`, `surge2ChooseH()`, `surge2HHClose(A, esd)`,
`xfer2TripNow(A)`. Geometry from `cfg.surge2` (cap 100 bbl, D 6 ft by default; host input `wts_surge2Cap`); the geometry key
`gk` (L523) and `captureFractions/applyFractions` gain T-202. Set point
`Psp2 = isNum(cfg.surge2.Psp) ? cfg.surge2.Psp : PspU` (follows T-201), ramped like T-201; `psh/pshh/mawp` derived with the T-201
formulas. Initial state (`create`, `reset`): empty, gas at the set pressure, XV-202 per `ctl.surge2.inlet` (default shut).
Temperature `Tu2` mixes like `Tu`.

### 5.2 Inlet manifold, routing and split
- **Legacy path:** while `!(rSurge2 && u2pos > 0)` the existing routing code runs untouched (Pd = Pu, A/B split by position).
- **T-202 only** (XV-201A/B shut, XV-202 open): Pd = Pu2; all dumps, flash and blow-by to T-202.
- **Both open — pressure-driven split with check valves** (research §2.4). Branch k ∈ {1: T-201, 2: T-202}, opening
  `x1 = min(1, posA + posB)`, `x2 = u2pos`, back-pressure `b_k = P_k` (top inlets into the gas space, so no liquid head — as the
  legacy Pd = Pu), conductance `C = qDd/√inletDP_psi` for both branches (qDd = the design dump flow, oil + water, of `derive()`;
  inletDP_psi 3). Flow `q_k = C·x_k·√max(0, Ph − b_k)`; a branch with `b_k ≥ Ph` carries zero (check valve, never negative).
  Header pressure `Ph` from `Σ q_k = q_dump`:
  ```
  b_lo ≤ b_hi (sorted), c_lo = C·x_lo, c_hi = C·x_hi
  if q_dump ≤ 0:                       Ph = b_lo
  else if q_dump ≤ c_lo·√(b_hi − b_lo): Ph = b_lo + (q_dump/c_lo)²            (only the lower-pressure branch flows)
  else: 12-step bisection of c_lo·√(Ph − b_lo) + c_hi·√(Ph − b_hi) = q_dump on [b_hi, b_lo + (q_dump/c_lo)²]
  shares s_k = q_k / q_dump
  ```
  **Review fix:** the split pressure only sets the shares; `X2.Ph` (the dump back-pressure and the snapshot `surge2.Ph`) is `b_lo`,
  the lower vessel pressure, as on the single routes (Pd = vessel pressure, no inlet loss). The conductance was sized on the
  average design flow, so the on/off dump flow put Ph ≈ 8 psi above both vessels; a second open path now never raises the
  back-pressure (≤ the single-route value).
  `q_dump` is this substep's dump flow computed with the back-pressure `Pd = X2.Ph` from the previous substep (one-substep lag,
  h ≤ 0.25 s, no iteration); `X2.Ph` initialises to `b_lo` when both inlets first open. Oil and water dumps and flash gas
  (`qFlash_k = dmpO_k·max(0, RsE(Psep) − RsE(P_k))`) go by `s_k`; blow-by gas (`oilDumpStuckOpen`) follows the liquid shares, and
  with no liquid flowing goes to the branch with the lower `b_k` (within 0.5 psi: by `x_k`). Inside T-201 the existing A/B split
  by position. `Ph` is published as `surge2.Ph`, `s_2` as `surge2.share`.
- `setSurgeRoute(mode)`, mode ∈ `'surge'` (T-201) | `'surge2'` (T-202) | `'both'`, make-before-break: open the new inlet(s)
  first; a pending-close flag closes the old one(s) when the new valve reaches full open (stroke end event-located in
  `chooseH`). `'surge'` opens both XV-201A/B when both are shut. Refused (`{ok:false, msg}`) when T-202 is out or at LSHH-202
  for a route into T-202. The derived `surge2.route` = `'surge' | 'surge2' | 'both' | 'none'`.
- `setValve('surge2', 0, open)`: XV-202 alone, own travel at `1/xvStrokeS` (no A/B hold logic). The "last open inlet" rules of
  T-201 (`armClose/valveEnds`, L884-924) count an open XV-202 as an open route.
- `SURGE_BLOCKED` / `blkU` / `surgeBlocked()` (L1191): blocked only when XV-201A, XV-201B **and** XV-202 (or T-202 out) are shut;
  message names the three valves when T-202 is in.
- Auto route (S): `ctl.surge2.auto` (default off). When the route is T-201 and every open T-201 compartment ≥ `sp` → route to
  T-202 (if T-202 < `sp − hyst`); when the route is T-202 and T-202 ≥ `sp` and a T-201 compartment ≤ `sp − hyst` → route back.
  The T-201 A ↔ B auto-divert is unchanged. Crossings event-located only while auto is on.
- **`LAH_SURGE_BOTH` vs the auto route:** while T-202 is in, the auto route is on and T-202 is below `sp − hyst`,
  `LAH_SURGE_BOTH` is suppressed (the auto route has room); its text suggests routing to T-202 when T-202 is in and the auto
  route is off. New `LAH_SURGE_ALL` (LAH-202, alarm, `eq:'surge2'`): both T-201 compartments **and** T-202 at or above `sp` —
  'all surge tanks high'.

### 5.3 Gas side
- PCV-203 back-pressure valve: PI with feed-forward like PCV-201 (`bpv2Kc`, `bpv2Bias` = flash + blow-by + displaced gas − SP
  ramp storage), sized like PCV-201 (`max(3·design flash, 50 Mscf/d)` at 50 % open), anti-wind-up, held shut with a frozen
  integrator when T-202 is out; fault `bpv2StuckClosed` holds it shut. Gas to the flare header.
- PCV-204 blanket from separator gas: open when `rSep && rSurge2 && Psep ≥ 0.9·SPe`, P-only with its own deadband, flow capped at
  0.5·n_s/h (as PCV-202), `Cv_mk2` sized as `Cv_mk` on T-202's design. **Held shut while `PSHH_SURGE2` is active.**
- PSV-202 lifts at `mawpU2`, reseats at 0.93; relief to the flare header. **Capacity `Cv_psvU2`** (in `derive()`; do not reuse
  `Cv_psvU`, do not halve for a split):
  ```
  P1 = max(SPa, mU2a + 1), mU2a = mawpU2 + PSC
  Qreq = max( gq(max(Cv_o, Cv_w), P1, mU2a, TRs, Zf(P1, TRs)),          gas blow-by, larger dump valve wide open, all into T-202
              gq(Cv_mk2, SPa, mU2a, TRs, Zf(SPa, TRs)),                 PCV-204 wide open
              3·qFlashD,                                                design flash with PCV-203 blocked
              surge2.psvMinMscfd·1000/86400 )
  Cv_psvU2 = Qreq / gq(1, 1.10·mawpU2 + PSC, P2a, TRs, Zf(1.10·mawpU2 + PSC, TRs))    relieves Qreq at 10 % accumulation
  ```
  The fire case is not modelled (card note, known limitation). **The two PSVs have different bases on purpose:** PSV-201 keeps
  its v3.3 sizing (2·Cv_o blow-by relieved at MAWP, frozen for bit-identity), PSV-202 uses the formula above (one valve's blow-by
  at 10 % accumulation), so on SAMPLE_FLOW PSV-202 has ≈ 46 % of PSV-201's Cv (23.96 vs 51.64). PSV-202 holds its own worst
  modelled case (PSHH-202 defeated, PCV-203 stuck closed, LCV-102 stuck open: peak 50.23 psig ≤ 1.1 × MAWP); the PSV-202 card
  note states the basis.
- Flare totals (`cum.flare` L1560, `qFl` L1826, `qgFlare` history) add PCV-203 and PSV-202. Flux limiters: the separator limiter
  (L1493) becomes `qPcv + qPsv + qBlk + qBlk2 + qBlowO + qBlowW` (`qBlk2` = 0 when T-202 is out, so the legacy sum is unchanged
  bit for bit) and scales `qBlk2` with the others; T-202's own limiter `qBpv2 + qPsvU2 ≤ X2.n_u/h` (as L1495 for T-201).
- **Gas accounting with T-202** (stated, not left to the balance): `qFlash = qFlash1 + qFlash2`, so `emaFlash`, `cum.flash` and
  `rates.gor_scf_stb` (L1943) include T-202's flash; the T-301 flash of oil transferred from T-202, `gvent2 = po2·RsE(Pu2A, Tu2)`,
  is added to both `cum.gaugeFlash` and `cum.gaugeVent` (the balance cannot see it missing, since it is a source and a sink);
  T-202's vacuum-breaker air goes into `cum.vacBreak`. `rates.shrink_pct` (L1946) uses the transfer-weighted
  `BoR = (xo1·BoR(PuA,Tu) + xo2·BoR(Pu2A,Tu2))/(xo1 + xo2)` with new cumulative transfer totals `cum.xo1` / `cum.xo2` (STB through
  LCV-201 / LCV-202, updated only while T-202 is in); with `xo2 = 0` the legacy formula runs.

### 5.4 Transfer LCV-202
On/off level control on T-202's own level (on at `lsh` 0.70, off at `lsl` 0.25); command when `rSurge2`, on, not latched, not
stuck (`xfer2StuckClosed`), and a T-301 inlet passing or no gauge tank. `ΔP2 = xferDP2()` = Pu2 + 0.4331·SG·(head − T-301
lift); `q = liqQ(Cv_x2, ΔP2, SG)`; draw by phase share of T-202's inventory. Sizing `pumpDesign2` as `pumpDesign` (L558).
Destination: the T-301 inlet header (`giO/giW` become the sum of LCV-201 and LCV-202) or the export line without T-301.
`segs[5]` velocity in `refresh` uses the sum of both transfers. LSHH-301 (`pumpLatched()` L1133, `LSHH_GT`) shuts both.

### 5.5 Alarms and trips (`eq:'surge2'`; skipped entirely while T-202 is out, released once on removal by §3.3)
| id | tag | sev | condition | action |
|---|---|---|---|---|
| `PSHH_SURGE2` | PSHH-202 | trip | Pu2 ≥ pshh2 | `surge2HHClose(A, true)`: close XV-202 (fail-safe, logged), hold PCV-204 shut, **then ESD** (`autoTrip`). Blocks the ESD reset while active (a real trip) |
| `PSH_SURGE2` | PAH-202 | alarm | Pu2 ≥ psh2 | check PCV-203 / flare header |
| `PSV_SURGE2` | PSV-202 | alarm | PSV-202 lifting | relief to flare |
| `LSHH_SURGE2` | LSHH-202 | trip, `act:'xv202'` | level ≥ lshh (0.90); non-latched (clears with the level deadband) | close XV-202, **no ESD**. With another inlet open the dumps carry on there; with none, the existing chain (`SURGE_BLOCKED` → LSHH-102 → ESD) shuts the well in. XV-202 stays shut until the operator reopens it below LSHH-202 |
| `LSLL_SURGE2` | LSLL-202 | warn | level ≤ lsll (0.05) with LCV-202 open (grace as T-201) | — |
| `XFER2_DRYRUN` | LCV-202 | trip, `act:'xfer2'` | LSLL-202 while transferring | latch LCV-202 shut (no ESD); reset via `resetTrip('XFER2_DRYRUN')` once above `lsl` |
| `XFER2_FAIL` | LCV-202 | alarm | commanded open, no flow (stuck) | — |
| `XFER2_LOW_DP` | LCV-202 | warn | open with ΔP2 < xferMinDP | — |
| `LAH_SURGE_ALL` | LAH-202 | alarm | §5.2 | all surge tanks high |

`Q_SURGE2` = `['PSHH_SURGE2','PSH_SURGE2','PSV_SURGE2','LSHH_SURGE2','LSLL_SURGE2','XFER2_DRYRUN','XFER2_FAIL','XFER2_LOW_DP',
'LAH_SURGE_ALL']` (every T-202 id; `quiet()` clears the ones without `act`, and §3.3 releases the two with `act`).
`raise()` (L1058-1069), ES5, act branches before the generic trip branch:
```
if (A.act === 'pump') pumpTripNow(A);
else if (A.act === 'xfer2') xfer2TripNow(A);                 // latch LCV-202 shut, no ESD
else if (A.act === 'xv202') surge2HHClose(A, false);         // LSHH-202: XV-202 shut, no ESD
else if (A.sev === 'trip' && A.id !== 'ESD_TRIPPED') {
  if (A.id === 'LSHH_SURGE') surgeHHClose();
  else if (A.id === 'PSHH_SURGE2') surge2HHClose(A, true);   // XV-202 + PCV-204 shut, then the ESD below
  autoTrip(A);
}
```
`blockingNow()` (L2302) and the snapshot `esd.blocking` list (L1970) change `A.act !== 'pump'` to `!A.act` — bit-identical today
(only `PUMP_DRYRUN` and `LSHH_GT` carry `act`, both `'pump'`), and it keeps `XFER2_DRYRUN` and `LSHH_SURGE2` from blocking the
ESD reset. `tripBlock`, `tripPeek`, `resetTripNow` id lists (L2215, L2221) gain `XFER2_DRYRUN`. PSHH-201 keeps its v3.3 action
(ESD only) for bit-identity — known limitation.

### 5.6 Faults (append)
`xfer2StuckClosed` 'LCV-202 stuck closed', `bpv2StuckClosed` 'PCV-203 stuck closed'.

### 5.7 Out of the rig-up, balances
Out: no connection, inventory frozen (it comes back with what it held), all T-202 blocks skipped. Inventories
`invOil/invWater/invGas` (L650-652), `setRef`, `zeroCum`, `massErr` always include `uo2/uw2/n_u2`, so the oil / water / gas
balances hold for every rig-up and every switch. The gas terms of §5.3 are tested directly (§9.2), not only through `massErr`.

### 5.8 Shared-code change list (31, owned by WP-E2)
Routing L1418-1423, L1471, L1493-1520 (split, limiter), overflow L1538-1548 (T-202 full → flare header, as T-201's last
resort), flare L1560 / L1826, rates L1943 / L1946, `blkU` / `surgeBlocked`, `LAH_SURGE_BOTH` suppression (L1265), `pumpLatched`,
`raise` act branches, `blockingNow` / snapshot blocking, `tripBlock` / `resetTrip` lists, valve helpers / `setValveNow`
(L2180-2195, `eq 'surge2'`, open refused at LSHH-202), `setControls` / `getControls` (`ctl.surge2`), `chooseH` L1661 (T-202
gas-residence cap, LCV-202 lsh/lsl, XV-202 stroke end — all inside `if (rSurge2)`), `refresh` segs[5], and the §3.3 T-202 items
of `setRigNow`.

---

## 6. Interfaces (exact; frozen in `tests/_wts-equip-shapes.js` by WP0)

### 6.1 Exports (`WTS_sim`)
Added: `RIG_DEFAULTS`, `RIG_OPTIONAL`, `stepFor`, `sand` (pure helpers, §4.2). Changed: `VERSION '1.4.0'`, `RIG_KEYS` (10),
`RIGUP` (10), `TAGS`, `NAMES`, `NULLABLE`, `FAULTS` (16), `DEFAULTS` (+`desander`, `sand`, `surge2`), `SAMPLE_FLOW.sim` (+7 keys,
§6.3).

### 6.2 `DEFAULTS` additions (deep-frozen)
```js
desander: { rating_psi: 10000, sithp_psig: null, tempMin_F: -50, tempMax_F: { 5000: 250, 10000: 350, 15000: 350 },
  Ain_ft2: 0.0341, K_dp: 6, dpAlarmHi: 75, dpHighRatio: 2, dpHighAdd: 5, dpLowFrac: 0.5, dpLowMin: 2,
  d50ref_um: 25, vref_fts: 30, muRef_cp: 1.0, drhoRef: 103, vMin_fts: 10, vMax_fts: 60, m: 2.0, gvfKnee: 0.90, gvfGain: 0.5,
  rhoSand: 165.4, porosity: 0.40, acc_gal: 50, buf_gal: 20, lah: 0.80, lahh: 0.95, effFillKnee: 0.90, packDpGain: 10,
  plugFactor: 3, washFactor: 0.3, washCut: 3, slugCut: 1.5, bypassLeak: 0.10, warmFactor: 3,
  dump: { isoS: 8, bleedS: 300, flushS: 600, equalS: 120, reopenS: 8, bleedTo_psig: 50, bleedTimeoutS: 600, equalTol_psi: 75,
          isoPassTauS: 30 },
  autoSp: 0.80, chokeCoupling: true },
sand: { pptb: 0, lbPerMMscf: 0, d50_um: 150, sigmaG: 2.0, rateExp: 1.5,
  flowback: { W0_lbph: 200, tau_h: 6, d50_um: 400, sigmaG: 1.5 },
  chokeWarn_lbd: 5, chokeAlarm_lbd: 50, sepWarnFrac: 0.10,
  erosion: { K: 2.0e-9, n: 2.6, rhoT: 7800, alphaDeg: 60, cL_fts: 4000, allowance_mil: 125, testH: 72, warnFrac: 0.05,
             highFrac: 0.50 } },
surge2: { cap_bbl: 100, D_ft: 6, Psp: null, psh: null, pshh: null, mawp: null, lsll: 0.05, lsl: 0.25, lsh: 0.70, lshh: 0.90,
  pumpBpd: null, pumpMinBpd: 500, pumpVelFrac: 0.7, psvMinMscfd: 50, xferMinDP: 1, inletDP_psi: 3,
  bpv: { tauCl: 10, Ti: 30 }, blanket: { on: true, deadband: 1, band: 2 }, autoSp: 0.80, autoHyst: 0.10, xvStrokeS: 6 }
```

### 6.3 `flow.sim` and host inputs
| `flow.sim` key | `cfg` path | Host input (Dynamic Simulation card, untagged imperial, appended to `WTS_IDS`) | Range (host `wtsClamp` and engine clamp) | Default / `SAMPLE_FLOW.sim` |
|---|---|---|---|---|
| `sand_pptb` | `sand.pptb` | `wts_sandPptb` "Sand rate, liquid (lb/1000 bbl)" | 0–500 | 0 |
| `sand_lbmmscf` | `sand.lbPerMMscf` | `wts_sandGas` "Sand rate, gas (lb/MMscf)" | 0–100 | 0 |
| `sand_d50_um` | `sand.d50_um` | `wts_sandD50` "Sand median size (µm)" | 20–1000 | 150 |
| `desRating_psi` | `desander.rating_psi` | `wts_dsRating` select 5000 / 10000 / 15000 "Desander rating (psi)" | one of the three, else 10000 | 10000 |
| `desAcc_gal` | `desander.acc_gal` | `wts_dsAcc` "Desander accumulator (gal)" | 10–200 | 50 |
| `sithp_psig` | `desander.sithp_psig` | `wts_SITHP` "Max shut-in wellhead pressure (psig)" — blank = estimated (1.2 × WHP), shown as such | blank, or 100–20,000 | null |
| `surge2Cap_bbl` | `surge2.cap_bbl` | `wts_surge2Cap` "Surge tank 2 capacity (bbl)" | 20–500 | 100 |

Capacities (`desAcc_gal`, `surge2Cap_bbl`): a value ≤ 0 counts as missing in `flowDerived` (default kept), as v3.3's
`surgeCap_bbl` and the host rule below (0 / blank → default); a small positive value is clamped up to the lower bound.
Host: `wtsClamp(gv(..) || def, lo, hi)` as for `wts_surgeCap` (host L126668); `wts_SITHP` is clamped only when not blank (the
wts3d host calc runs in a stub DOM). Engine `flowDerived` (L322-331): `isFin` plus the same clamp for the seven keys (an
`Infinity` typed as `1e400` never gets through). `SAMPLE_FLOW.sim` gains the seven keys with the default values (shape-equality
test); `flow.inputs`, `validFlow` and `normFlow` are unchanged. `sithp_psig` is a design value only: the shut-in build-up curve
keeps `ramp.sithpFactor` (unchanged).

### 6.4 Snapshot additions (always present; static values when the item is out; all finite unless in §6.10)
```
desander: { tag:'DS-101', inRig, bypass, bypassTag:'HV-104', Pin, Pout, dP_psi (= X.PD), dPclean_psi, dPexp_psi, dPdesign_psi,
            T, Tout, vIn_fts, rate:'none'|'ok'|'low'|'high', gvf, rhoMix, carrier:'liquid'|'gas', mu_cp, d50c_um, eff, effClean,
            sand: { in_lbd, capt_lbd, out_lbd, acc_lb, acc_frac, cap_lb, buf_lb, buf_frac, bufCap_lb, lah, lahh },
            dump: { tag:'XV-103', phase:'idle'|'isolate'|'bleed'|'flush'|'equalise'|'reopen'|'held', heldFrom:''|<phase>,
                    phaseT_s, left_s, open, Pacc, count, lastT, failed, failMsg },
            auto: { on, sp, blocked }, rating_psi, sithp_psi, sithpEst, ratingOK, tempMax_F, tempOK }
sand:     { on, pptb, lbPerMMscf, d50_um, sigmaG, in_lbd, toChoke_lbd,
            flowback: { on, W0_lbph, tau_h, t_h, d50_um, sigmaG },
            choke: { Up_fts, C2, erosion_mpy, erosion_mild, band:'none'|'ok'|'warn'|'high', warn_mild, high_mild, loss_mil },
            sep: { lb, ft3, frac },
            cum: { in_lb, capt_lb, toChoke_lb, toSep_lb, toFlare_lb, dumped_lb } }
surge2:   { tag:'T-202', inRig, P, SP, SPeff, T, psh, pshh, mawp, cap_bbl, D, H, h, frac, hW, fracW, Vo_bbl, Vo_stb, Vw_bbl,
            flash_mscfd, tFull_s, valveTag:'XV-202', inlet, pos, moving, fill_bpd, route, share, Ph, auto:{ on, sp, hyst }, strokeS,
            bpv:{ tag:'PCV-203', u }, blanket:{ tag:'PCV-204', u, held }, psv:{ tag:'PSV-202', lifting, Cv },
            transfer:{ tag:'LCV-202', on, tripped, failed, blocked, q_bpd, design_bpd, x, dP_psi, dPdesign_psi, Cv, sg,
                       lowDP, dest, trip, canReset, resetBlock },
            lsll, lsl, lsh, lshh }
nodes.desander: { tag:'DS-101', P (outlet = choke inlet = X.PB), Pin (= X.PBu), dP, T, Tout, Tacc, th, hyd }
                (out: P = Pin = X.PB, dP 0)
nodes.surge2:   { P, T }
nodes.esd.P     = X.PBu when DS-101 is in (else X.PB, as today) — continuous across PD steps;  nodes.choke.Pin = X.PB (unchanged);
                  segs[1].P0 = nodes.esd.P
rigup:          + desander, surge2, extras[], refused ('' | note, §3.3)    (sig 10 characters)
health.massErr: + sand
faults:         + 8 keys (object keyed by FAULT_IDS)
```

### 6.5 Lines (append; each `{q, unit, frac, vel, ID_in, phase, active}`)
`sep_surge2` (dump branch into T-202, bpd, liquid), `surge2_gauge` (LCV-202, bpd, liquid), `surge2_vent` (PCV-203, Mscf/d, gas),
`blanket2` (PCV-204, Mscf/d, gas), `psv_surge2` (PSV-202, Mscf/d, gas), `ds_dump` (XV-103, lb/d, phase `'sand'`, active during
`flush`). Self-test 13 (L2380) pins 20 names.

### 6.6 History (append to `HIST_KEYS`)
`surge2Frac`, `surge2P`, `dsAccFrac`, `dsDP`, `sandChoke` (lb/d).

### 6.7 API (instance)
| Call | Returns | Notes |
|---|---|---|
| `setRigup({desander, surge2, …})` | bool | partial; null → item default; false when refused (§3.3, note says why) |
| `getRigup()` | 10 booleans | |
| `dumpDesander(cmd)` | `{ok, msg}` | `cmd` `'start'` (default) / `'resume'` / `'abort'` (§4.4) |
| `setDesander({bypass?, auto?:{on?, sp?}})` | bool | `sp` clamped 0.5–0.95 |
| `setSurgeRoute(mode)` | `{ok, msg}` | §5.2 |
| `setValve('surge2', 0, open)` | bool | XV-202 |
| `setAutoDivert('surge2', on)`, `setValveOptions('surge2', {sp, hyst, strokeS})` | bool | as for `'surge'` |
| `resetTrip('XFER2_DRYRUN')` | as today | |
| `setFault(id, on)` | as today | eight new ids |
| `setConfig({sand:{…}, desander:{…}, surge2:{…}})` | as today | re-derives; values clamped (§6.3) |
| `WTS_sim.stepFor(rig)` (static) | `{eqId: '①'…}` | §3.5 |

### 6.8 Events and log
New emit name `'dump'` `{type:'dump', t, phase, msg, auto}` (start, each phase, held, resume, abort, end, fail). Existing
`'divert'` / `'control'` carry `eq:'surge2'` / `'desander'`. Log entries use the existing types only (`event` with ids `DS_DUMP`,
`DS_BYPASS`, `ROUTE`; `fault`; `raise`/`clear`/`trip`) — the allowed type list of self-test 13 is unchanged.

### 6.9 Controls (`getControls()` / `setControls(c, {initial})`)
`{ surge, gauge, surge2: { inlet:false, auto:false, sp:0.80, hyst:0.10, strokeS:6 }, desander: { bypass:false, auto:false,
sp:0.80 }, v:1 }`. `setControls` reads the new keys optionally (old prefs without them keep the defaults; the divert round-trip
tests keep passing). Persisted by 38 in `h2viz3d_prefs.ctl` as today; precedence as §3.3.

### 6.10 `NULLABLE` additions
`desander.dump.lastT`, `surge2.tFull_s`, `surge2.transfer.trip` (and the copy in 32, L174).

### 6.11 Contract fixture (WP0)
`prism-build/tests/_wts-equip-shapes.js` exports frozen: the RIG_ITEMS additions, `RIG_DEFAULTS`, tag / alarm / fault ids, line
and history names, the §6.4 snapshot additions with the §4.9 example values, the controls shape, the four `stepFor`
combinations (§3.5), the 3D → 38 action payloads `{type:'dump', eq:'desander'}`, `{type:'bypass', eq:'desander'}`,
`{type:'valve', eq:'surge2', idx:0}`, and a `fakeEquipSnapshot(base, {desander, surge2, flushing, held})` helper that the view
builders use before the engine lands. The engine's real snapshot is checked against it (`wts-equipment.test.js`).

---

## 7. Performance and determinism

- Budget today: self-test 14 (4 h at dt 10, < 500 ms) measured 443 ms direct and once 620 ms under the vm runner; ≈ 8–9 µs per
  substep, 57,959 substeps per 4 h; `processAlarms` and `chooseH` run every substep. Run-to-run noise on unchanged code
  (`simeq/perf-noise.js`): 348–872 ms in one process, medians of runs 1–5 vs 6–10 differing by 19–29 % — a "median of 5 before
  and after" cannot resolve a 2 % change.
- **Method actually used (WP0 / WP-E0 review; supersedes the single-process description below):** `wts-sim-perf.js` runs
  `--rounds` (default 7) fresh child processes; each loads **two** vm contexts per engine (alternated pair by pair; the load order
  of the two engines alternates with the round), 2 warm-ups per context, then ≥ 10 interleaved A/B pairs of 4 h at dt 10 on
  `SAMPLE_FLOW` (seed 14). Gate values: **minRatio = median over the rounds of the per-round ratio of minima**, **medianRatio =
  median of all per-pair ratios pooled over the rounds**; both ≤ 1.05. A/A noise on unchanged code (2026-11-01, 4-core box under
  load): one process with one context per engine gave min ratios 0.88–1.27 (a context can be unlucky in what the JIT makes of
  it); per-round min ratios with two contexts 0.80–1.17; the two gate values stayed within about ±0.03 of 1 with 7 rounds.
  WP-E0 measured 1.022 / 1.013 (review run), so E1 + E2 together have only about 3 % headroom on the default spread:
  **WP-E1 and WP-E2 each re-run the gate** before handing over, and the lead re-runs it after each merge (§10.4). The both-in
  ≤ 1.6 (planned 1.4) check times the stub bodies until E1 / E2 land (≈ 1.0 at WP-E0): it is meaningful only from WP-E1 / WP-E2 onwards.
- **Gate (default spread: both out, sand 0): new / v3.3 ≤ 1.05**, measured by the new tool `prism-build/wts-sim-perf.js` (WP0):
  it loads the frozen v3.3 engine `tests/_wts-sim-v33.js` and the working `31-wts-sim.js` into two vm contexts in one process,
  discards 2 warm-up runs of each, then runs ≥ 10 interleaved A/B pairs of 4 h at dt 10 on `SAMPLE_FLOW` (seed 14) and compares
  both the ratio of the minimum times and the median of the per-pair ratios (exit 1 if either > 1.05). Backed by a code-review
  check that every new per-substep block sits behind `rDes`, `rSurge2` or `sandOn` (only three predictable branches on the hot
  path; new alarm groups, event location and history keys behind the same flags). **Accepted deviation (WP-E0 review):** the
  history hooks `desHist(i)` / `surge2Hist(i)` run on every history sample whatever the rig-up and write 0 while the item is
  out, so the ring never holds stale entries after a removal. They run once per history sample (`histDt`), not per substep, and
  cost nothing measurable; no gating or transition zero-fill is needed.
- **Both in, flow-back on:** ratio of minima against the default spread in the same context ≤ **1.6** (same tool; no absolute
  millisecond budget, which a cold vm or a slow CI box would break).
  **WP-I decision (2026-11-06):** the planned 1.4 was set before E1 / E2 existed. Measured on the integrated engine (4-core
  box, `run` of the same workload, best of 10): DS-101 alone (flow-back on) ≈ 1.23, T-202 alone (route both) ≈ 1.27, both
  ≈ 1.45 (gate tool 1.45–1.50 before the fix below): the two costs add, each is the item's own physics (T-202 adds a second
  vessel flash / Bo per substep: 7.4 instead of 4.3 Rs evaluations; DS-101 adds its ΔP lag, capture, dump sequence and ten
  alarms per substep). The atmospheric-Rs memo (`RsAtm`) was widened from two to four temperatures (it thrashed with T-202's
  third vessel temperature; bit-identical, no change on the default spread). The gate is raised to 1.6: about 1.8 ms per
  simulated minute with both in, i.e. well under 1 % of a core at the ×60 play speed. The default-spread gate (≤ 1.05
  against the frozen v3.3 engine) is unchanged.
- Bundle and startup: `node prism-build/perf-budget.js` (bundle ≤ baseline × 1.10, startup ratio) at WP-I; re-record the
  baseline only if an increase is intended.
- Self-test 14 stays on the default spread and becomes **best of 2 runs** (S, WP-E0) to remove the vm-runner outlier.
- **Bit-identity:** with both items out and sand 0, every v3.3 snapshot path equals, exactly (`===`), the frozen v3.3 engine run
  side by side in the same process (§9.2, scenarios a–e); `rigup.sig.slice(0,8)` equal and `.slice(8) === '00'`; new keys
  ignored. No stored golden, no rounding, nothing machine-dependent, nothing to regenerate. No new draws from the main PRNG; a
  future noisy sand reading (C) uses its own seeded stream.
- Determinism and step size: same seed → same state with both in; dt 1 vs dt 10 over 2 h agree within the tolerances of
  self-test 6 for levels / pressures and within 1 % for sand totals.

---

## 8. Views

### 8.0 Rule for every view (D18)
Every table of optional items that a view reads is **filtered by the effective rig-up** before use: picking, occlusion,
obstacles, framing, focus, chips and labels, step numbers, tracers, lamps, 2D glyphs, valve zones and tap targets. A hidden item
has no volume anywhere. Tests check the both-out state against v3.3 (§9.2).

### 8.1 3D scene (`32-wts-3d.js`, WP-3D)
World frame: x along the flow, y up, z towards the default camera. Both items sit **behind** existing equipment so the default
overview (az −18°, el 20°) is unchanged.

**DS-101** (group `beginGrp('desander')` after the CK-101 block, L1585–1607):
- Skid 1.0 × 0.12 × 1.0 at (−10.2, 0.06, −1.6); glass accumulator (`vessel()`, kind `'v'`) R 0.34, straight 0.9, head 0.17,
  base y 0.35, sand shown with the phase hull (`U.uWatCol` = sand colour, `uSecA = (sandH, liquidH)`); opaque steel cyclone
  housing r 0.20 from y 1.6 to 2.8 with a cone into the accumulator, tangential inlet nozzle at y 2.5 (+x side), overflow on top.
- PI dial `'dsIn'` reusing face 0 (wellhead range; atlas unchanged). Status lamp: green / amber LAH / red LAHH / blue blinking
  while dumping / amber steady while held.
- Sand skip (open box 1.2 × 0.9 × 0.7) at (−10.2, 0.45, −3.5); dump line DD at y 0.4 along −z with XV-103 at (−10.2, 0.4, −2.6);
  tan smoke sprite at the skip during `bleed`/`flush`. Small block-valve handwheels on D1 and D2 (shown shut in the bypass line-up).
- Routes (replace the first leg of today's E2; ids appended to `ROUTES`):
  `D0a [[-11.2,1.2,0],[-10.75,1.2,0]]` (always), `D0b [[-10.75,1.2,0],[-9.3,1.2,0]]` (bypass leg with HV-104 at x −10.0; the plain
  line when DS-101 is out), `D1 [[-10.75,1.2,0],[-10.75,2.5,0],[-10.75,2.5,-1.6],[-10.45,2.5,-1.6]]` (to the tangential inlet),
  `D2 [[-10.2,2.9,-1.6],[-10.2,3.2,-1.6],[-9.3,3.2,-1.6],[-9.3,1.2,-1.6],[-9.3,1.2,0]]` (overflow back to the line, clear of the
  choke skid x ≥ −9.1), `E2 [[-9.3,1.2,0],[-8.65,1.2,0],[-8.65,1.2,0.6],[-7.4,1.2,0.6]]`, `DD` (dump). D0a + D0b + E2 has the
  length of today's E2.
- `aSeg`: D0a/D0b/D1/D2 = 1 (seg-1 tint and alerts), DD = 12 (the grey index) so the 14-slot shader arrays do not grow.
  `TEES` (−10.75, 1.2, 0) and (−9.3, 1.2, 0) with size 4 and the radius rule `t[3] === 4 ? nps[1]`; `buildPipes` base offsets for
  the new ids; one support stand each on D0b and D2. `SEG_CHIPS` s1 → (−9.0, 1.2, 0).
- Tracers: MULTI chain `['E1','D0a','D1','D2','D0b','E2','E3','E3c','E4a','E4']`; `nextE[D0a] = in && !bypass ? D1 : D0b`,
  `nextE[D1] = D2`, `nextE[D2] = E2`, `nextE[D0b] = E2`; activity `D1/D2 = esd_choke.active && in && !bypass`,
  `D0b = esd_choke.active && (!in || bypass)`. New chain `{id:'SAND', entry:'DD', phase:'sand', edges:['DD']}` **appended
  after `DR`** (`edgeState` reads `tr.chainEntry[7]` for DR, L2897). `pickPhase` (L2963) treats D0a/D0b/D1/D2 as upstream of the
  choke; phase 3 = sand in `PHA`/`PHS` and the tracer colour branch.
- **Tracer allocation** (L2404-2410): chain weights use **built edges only** (D1/D2 excluded from MULTI and SAND / X0 / BLK2 /
  VENT2 / PSV2 weight 0 while their item is out); every chain except DR is rounded first and **DR keeps the remainder** (today the
  last chain does, and DR is last). Default allocation per chain is unchanged (test).

**T-202** (group `beginGrp('surge2')` after the LCV-201 block, L1841–1854) at **(12.5, 0, 2.3)**, drawn at **R 1.0** (the 3D
vessels are not to scale; the engine's `D_ft` is separate), Ls 3.6, head 0.5 → y 0.9…5.5, no centre baffle; 4 legs, 2 stiffener
rings; PSV-202 on the **−x side** of the top head at about (11.9, 5.4, 2.3), clear of the VENT z-run at x 13.0; sight glass LG-202
on the camera side at about (12.75, 1.5…4.6, 3.40); dial `'surge2'` reusing face 2. Clearances at R 1.0: ≈ 0.66 m to T-201's
shell, ≈ 0.14 m to T-201's picking-proxy corner, ≈ 0.25 m to the gauge walkway handrail (x 13.75). The vessel position is fixed;
routes may move by up to 0.3 m to pass the clearance test.
- Inlet: split `LM` into `LMa [[8.1,0.55,2.4],[8.1,0.55,4.0],[8.1,2.9,4.0]]` and `LMb [[8.1,2.9,4.0],[8.1,4.2,4.0],[9.0,4.2,4.0]]`
  (tee at (8.1, 2.9, 4.0)); `LM2 [[8.1,2.9,4.0],[8.1,2.9,2.0],[11.55,2.9,2.0]]` (aSeg 8, ends on the R 1.0 shell) with XV-202 at
  (9.6, 2.9, 2.0). LW/LO chains use `['LW','LMa','LMb']`; `nextE[LMa]` follows the engine shares (`lines.sep_surge2.active`).
- Outlet (LCV-202, D13): `X0 [[12.5,0.9,2.3],[12.5,0.45,2.3],[12.5,0.45,3.6],[13.4,0.45,3.6],[13.4,0.45,4.0]]` (aSeg 5) with
  LCV-202 at (13.0, 0.45, 3.6), teeing into the base of the X2 riser **downstream of LCV-201**; chain `{id:'X0', entry:'X0'}`,
  `nextE[X0] = X2` with **`nextS[X0]` = X2's arc length up to (13.4, 0.45, 4.0)** (computed in `buildPipes` like `sDRBjoin`, so
  particles continue from the elbow instead of jumping back 0.6 m to LCV-201), active = `lines.surge2_gauge.active`.
- Gas: `VENT2 [[12.5,5.5,2.3],[12.5,6.1,2.3],[13.0,6.1,2.3]]` (aSeg 10) with **PCV-203** at (12.75, 6.1, 2.3), teeing into the VENT
  z-run downstream of PCV-201 (if VENT carries tracers, `nextS[VENT2]` = VENT's arc length to (13.0, 6.1, 2.3)); `BLK2
  [[7.6,4.9,4.0],[7.6,4.9,2.0],[11.55,4.9,2.0]]` (aSeg 9) with **PCV-204** — it leaves BLK part-way, so it is its own chain with no
  continuation; **PSV-202 discharge** `PSV2 [[11.9,5.85,2.3],[11.35,5.85,2.3],[11.35,4.1,2.3],[11.35,4.1,0]]` (aSeg 10, own chain)
  teeing into the PSV header (`PSV_ROUTE` y 4.1, z 0) at (11.35, 4.1, 0). Tees (8.1, 2.9, 4.0), (13.4, 0.45, 4.0), (13.0, 6.1, 2.3),
  (7.6, 4.9, 4.0), (11.35, 4.1, 0).
- **3D clearance test** (§9.2) on rendered primitives: vessels as vertical cylinders (shell + heads' bounding cylinder), pipes as
  capsules of their NPS radius, valves / dials as their boxes, and a hand-listed `PROPS` box table exported via `_internals`
  (walkway grating and handrails, gas-rack posts and crossarms, bund kerb y ≤ 0.24, DAQ cabin). `EQ_BOX` (framing only) and
  `PROXIES` (picking volumes may overlap) are **not** part of it. Minimum gap 0.05 m between primitives that are not joined.
- T-202 picking proxy is **inscribed**: centre [12.5, 3.2, 2.3], size [1.9, 4.6, 1.9] (≤ 2.0 × 4.9 × 2.0; x 11.55…13.45, clear of
  T-201's proxy x ≤ 11.45). `EQ_BOX.surge2` [[11.5,0,1.3],[13.5,6.0,3.3]].

**Tables and rig-up** (every `EQ_IDS` consumer crashes on a missing key):
- `EQ_IDS` +`'desander','surge2'`; `TAGS`, `TITLES` ('DESANDER', 'SURGE TANK 2'), `PREF_SIDE` (DS **'se'**, T-202 'ne'),
  `ANCHORS` (DS [−10.2, 3.5, −1.6], T-202 [12.5, 5.8, 2.3]), `OBST` (L2622, label obstacles: + the T-202 box when in),
  `HALO`, `PROXIES`, `EQ_BOX`, `VIEWS` (wellhead + desander; tanks / process + surge2), `FOCUS`, `BL` shadows, `vesselPoints`, `S.vesselsById`, `VES`.
- **Filtered by `N.rig` (§8.0):** `rebuildTier` (L3683) builds `S.proxies`, `S.valveProxies` and `S.obst` from the static arrays
  minus the items out; `pickAt` (L3426-3436) and `occlusion()` (L2806) use them instead of `PROXIES` / `VALVE_PROXIES`, and the
  label obstacle pass uses `S.obst` instead of `OBST` (L2622). `viewTarget` (L2564) and `FOCUS` take only groups that are in, so
  with DS-101 out the Wellhead & Choke framing and with T-202 out the Tanks / Process framing are those of v3.3. Optional chips are
  hidden and their `lodVis` off while out; chips are built once (`EQ_IDS.forEach(mkChip)`, L2613), so on a `rigSig` change the
  code re-applies visibility and rewrites each chip's `.n` text from `WTS_sim.stepFor(N.rig)` (fallback `STEP`).
- `FIT_PTS` (L69) becomes `fitPts(rig)` computed in `rebuildTier` (the DS-101 / T-202 boxes only when in). A rig-up change refits
  the camera **only when `userMoved` is false**; otherwise the camera stays where the user put it.
- `VALVE_PROXIES`: `'valve:surge2:0'` (XV-202), `'dump:desander'` (XV-103), `'bypass:desander'` (HV-104); `valveOf` (L3452)
  regex `/^(valve|suction):(surge|surge2|gauge):([01])$/` plus `/^(dump|bypass):desander$/`, producing exactly the fixture payloads
  (§6.11). LCV-202, PCV-203/204 are not operable (as LCV-201).
- Lamps / handwheels for XV-202, LCV-202, XV-103, HV-104 in their own groups; widen the lamp status bit-field `lsig` (L3244).
- `RIG_GROUPS` (L152) **append** `'desander','surge2'` → 8-character 3D sig (default `'11111100'`; the old sig is the prefix), so
  the rebuild gate (L3709) fires on a toggle. `rigSigOf` (L562) uses the optional rule for the two new groups (`rig[g] === true ?
  '1' : '0'`). Optional groups are **not built** when out (D18); `buildPipes` skips the geometry of routes tagged `rig:'desander'`
  (D1, D2, DD) or `rig:'surge2'` (LM2, X0, VENT2, BLK2, PSV2) when out, while `ROUTE_IDX` indices stay. The surge bypass spool
  (L1992–2003) keeps its v3.3 rule (drawn while T-201 is out — by D11 T-202 is then out too).
- `normalize` / `makeNorm`: `NODE_NAMES` (+desander, surge2) **and** the per-node fallback `sampleP`/`sampleT` arrays (L577) —
  appending a node without them gives NaN (self-test 6); `LINE_NAMES` +6; `N.ds`, `N.surge2`, `N.sand`; older snapshots → out.
  `fakeSnapshot` (L672) carries every new path. `PALETTE` `sandBody '#c8a165'`, `sandTracer '#e0bf7a'` (pass the dark-surface
  contrast check); `IMP_UNITS` `mass:'lb'`, `volumeSmall:'gal'`, `erosionRate:'mpy'`, `erosionDay:'mil/d'`.
- `updateLabelText` (L2653): desander `slot(Pin, P, '→', 'ΔP x psi' | 'DUMPING' | 'HELD' | 'SAND HIGH' | 'SAND x %')`, detail rows
  ΔP, Accumulator %, Sand caught, Sand rate, Capture, Last dump, Bypass, Auto-dump; surge2: level %, P, `IN OPEN/SHUT`, detail rows
  Volume, XV-202, LCV-202, Time to HH. `updateVessels` / `updateVesselParticles` / `updateParts` for T-202 and the accumulator.
- `STEP` stays as the fallback; chips use `WTS_sim.stepFor(N.rig)` (D17).
- `_internals` exports the new constants used by tests (`PROPS`, `fitPts`, the filtered-table builders).

### 8.2 2D schematic (host `wtsDrawDiag`, `WTS_DIAG_LAYOUT`, l.126912–127148; WP-2D)
- **Two fixed variants per row, no layout maths.** Top row: the v3.3 coordinates (`tx = [85,230,380,535,695,950]`) while DS-101 is
  not drawn; the DS-101 variant `txDs = [70,180,400,535,695,950]` with `ds = {x:290, cl:12}` while it is. Bottom row: the v3.3
  bottom row (straight pipe at `y = by` from `bx[0]+18`, LCV-201 at x 758) while T-202 is not drawn; the T-202 variant below while
  it is. `bx = [695,1000]` in every variant (four tests pin glyph positions to it). The variant keys are added to the
  `WTS_DIAG_LAYOUT` object literal; `wtsDrawDiag` picks `L` (the base object, or a copy with the variant keys applied) **before**
  the unchanged marker line `const tx=L.tx, cy=L.cy, bx=L.bx, by=L.by, cl=L.cl;`.
- `wtsDrawDiag(nodes, segs, opts)`: optional `opts.rigup`; DS-101 and T-202 drawn only when `opts.rigup.desander/surge2 === true`
  (38 passes `st.rigup`; the static calc and Mini WellOS pass nothing → exactly the v3.3 picture). Missing `nodes[8]` /
  `nodes[9]` → glyph with "—".
- **DS-101 variant:** glyph at (290, cy): cylinder 16 × 12 (cy−22…cy−10), cone to cy+6, accumulator 18 × 14 (cy+8…cy+22) with tan
  sand fill, LAH/LAHH ticks, dump bow-tie XV-103 at (306, cy+20) with a short "SAND" arrow, bypass marker HV-104 on a dashed arc over
  the glyph. Label 'Desander' at cy−48 (drawn separately, **not** inserted into `tlabels`), ΔP at cy−34 (→ `DUMPING` / `HELD`
  amber, `SAND HIGH` red), node P/T/hydrate at cy+50/63/76. Segment 1's phase label ('Multiphase', drawn by the loop after the
  regime block at the segment midpoint, cy−28) moves to the ESD → DS midpoint (≈ 237) so it does not land on the glyph top /
  ΔP text at x 290. The seg-0 run shrinks to 70 px: its spec label is shortened to the compact form (e.g. '4" S40') in this
  variant only. Nothing below cy+84 for x < 620 (strip).
- **T-202 variant:** `bx2 = 775` (T-202 glyph 30 × 38); inlet header at by−40 extended to 775 with XV-202 (12 × 14) at (769, by−33);
  T-201 outlet header at by+28 with **LCV-201 at x 738** (`RIG2D.lcvX2`) running under T-202 to a riser at x 822 up to `by`;
  T-202 side outlet at (790, by+12) → **LCV-202** at (805, by+12) → tee into the riser; segment 5 from 834 to `bx[1]−20`; the
  bottom 'Liquid' phase label at segment 5's midpoint (≈ 907) instead of `(bx[0]+bx[1])/2` (847, next to the riser). Labels
  'T-202' at by+38; bottom P/T labels to by+56/69 if crowded (legend row at 332). All positions to be confirmed on screen (≤ 15 px
  shifts allowed; tests pin only `bx` offsets).
- Host-patch markers (`wts-host-patch.js` "every anchor applicable once" and "idempotent") stay word for word:
  `const tx=L.tx, cy=L.cy, bx=L.bx, by=L.by, cl=L.cl;` (new keys on a **separate** line), `'ESD / SSV','Choke'`,
  `const WTS_DIAG_LAYOUT=`, `window.wtsDrawDiag=wtsDrawDiag;`, `sR(6,'Surge &rarr; Gauge Tank'`, `id="wts_sepID"`,
  `GW.WTS_state.flow=flow;`.
- Dynamic Simulation card: the seven inputs of §6.3 (`.fg-item` markup, ≥ 16 px on iOS via the existing rule).

### 8.3 Live controller and HMI (`38-wts-live.js`; WP-E0 foundation, then WP-L, except the 2D overlay functions owned by WP-2D)
- **WP-E0 foundation** (frozen before WP-L / WP-2D start): constant tables (L36–76) `EQ_IDS`, `TAG`, `NAME` ('Desander
  (cyclonic)', 'Surge Tank 2'), `EQ_ABBR` ('DSND', 'T-202'), `HOST_NM` / `NODE_KEYS` (append 'Desander', 'Surge Tank 2' →
  `liveNodes` returns 10; `liveSegs` stays 6), `INPUT_FOR` (desander → `wts_sandPptb`, surge2 → `wts_surge2Cap`), `IMP`
  (+mass, volumeSmall, erosionRate, erosionDay), `DEF_COL` / `palCol` (+sand), `RIG_FALLBACK` (+2), the §3.4 persistence and
  `renderRig` predicates, `rigIn`, the `stepFor` fallback, and the **equipment lookup** `EQV = { surge:{kind:'comps',
  valves:['XV-201A','XV-201B'], suction:true}, surge2:{kind:'single', valves:['XV-202']}, gauge:{kind:'tanks',
  valves:['XV-301A','XV-301B']}, desander:{kind:'desander', dump:'XV-103', bypass:'HV-104'} }` (replaces `eq === 'surge' ?
  'surge' : 'gauge'`, a silent wrong-valve bug: a `surge2` click would operate a T-301 valve); test hooks `_internals.sim()` /
  `useSim(stub)`.
- **WP-L** uses `EQV` in `onAction` (L1324), `doAct` valve / stroke / auto / autosp (L3006–3013), `toggleValve` (L1133–1147),
  `stepStroke`, `toggleAuto`, `stepAutoSp`, `openVin`; WP-2D in the 2D click regex `vm2`. Unknown `eq` → no action.
- **Scenarios menu:** ids from `WTS_sim.FAULTS` when present (local `FAULTS` = fallback, +8 rows). Order: the v3.3 local order for
  the ids it knows, then the remaining engine ids in `WTS_sim.FAULTS` order; labels: the local label when 38 has one (they are
  more descriptive and also used by the fault toasts, L1107), else the engine label. New local labels: 'DS-101 liner plugged',
  'DS-101 liner washed out', 'XV-103 stuck closed (desander dump)', 'DS-101 upper isolation passing (dump interlock)', 'HV-104
  passing (desander bypass)', 'Sand / proppant flow-back (clean-up)', 'LCV-202 stuck closed (T-202 transfer)', 'PCV-203 stuck
  closed (T-202 back-pressure)'. Menu length = `WTS_sim.FAULTS.length` (the GUI-sweep run job clicks that many).
- `rigOut(st,'surge')` stays at every existing call site (no `noSurge` refactor: by D11 it already means "no surge tank at all").
- Info cards (`cardSpec` L1868, `renderCardActions` L2050):
  - `desander`: Inlet P, Outlet P, ΔP (detail "clean x · expected y · design z"), Cut size, Capture, Accumulator (% and lb of cap),
    Buffer (while isolated), Accumulator pressure (while dumping / held), Sand in / caught / to choke (lb/d), Choke erosion (band +
    mil/d, mpy secondary, screening note), Last dump, Bypass, Auto-dump, Rating (✓ / ✗ against max SITHP, "estimated" when
    blank); sparks `dsAccFrac` + `dsDP`; sand strap bar. Actions: **"Dump sand"** (`data-act="ds-dump"`, red border) → the
    existing in-viz `confirmBox` (L2788) "Dump DS-101 sand to the skip? The accumulator is isolated, bled to below 50 psig, flushed
    and equalised (about 17 min); the well keeps flowing." → `_sim.dumpDesander()`; disabled with the reason while a dump runs or
    the ESD is tripped; while **held**: "Resume dump" / "Abort dump" (`ds-resume` / `ds-abort`, enabled after the ESD reset);
    Auto-dump ON/OFF + set point −/+ (copy of `autoRow` L2109; shows "blocked after a failed dump"); Bypass ON/OFF (HV-104
    line-up; note "DS-101 stays pressurised while bypassed until it is bled"). With sand off: hint "No sand in the well stream —
    set Sand rate in Dynamic Simulation or start Scenarios → Sand / proppant flow-back."
  - `surge2`: Level, Pressure (SP), Liquid of capacity, Water cut, Inlet XV-202, Route, Share of dumps, LCV-202 (state, q, ΔP),
    Time to HH, Flash gas; actions: route buttons T-201 / T-202 / Both, XV-202 open/shut, stroke row, auto route row, LCV-202 trip
    reset row. Card note: PSV-202 fire case not modelled.
  - `choke` card: rows Sand to choke and Choke erosion when sand is on. `separator` card: "Sand in V-101 (lb, ft³ bulk)" when
    `sand.cum.toSep_lb > 0`.
- HUD / tiles / popovers / trends / legend: `updateHud` surge line "Surge A x · B y · T-202 z · LCV-201 …" (T-202 part only when
  in), a `tDs` line "DS-101 sand x % · ΔP y" when in (re-measure HUD heights lg / md / sm with `ux-layout-check.js`; they feed
  the 3D insets); `updateTiles` `t_tanks` + T-202; `updatePop` press (+DS in/out, T-202 P) and tanks (+T-202, DS sand); trends:
  T-202 series in the surge cell and a 'Desander sand · ΔP' cell when in; legend 'Sand' swatch when DS-101 is in; toasts in
  `hookSim` for `'dump'`.
- Live 2D overlay (WP-2D): `draw2dLive` T-202 fill (`tankFill(bx2, by, 30, 38, …)`), accumulator sand fill, XV-202 / LCV-202 /
  XV-103 / HV-104 colours (green open, red shut, amber travelling), tan dashed dump line while flushing, dash lines on the new
  transfer path — all only in the variant where the item is drawn; `drawRig2d` per D18 (the v3.3 "transfer line not in use"
  mask unchanged: T-201 out implies T-202 out); **`valves2d(L, st)`** (signature gains `st`, filtered by `st.rigup`) used by
  `zones2d(L, st)` and `nearValve` (L2682-2720), so with an item out no zone or 22 px tap target exists on its slot. Zones in the
  variants: DS zone x 260…320; T-202 zone 760…790; XV-202 and LCV-202 zones; LCV-201 zone in the T-202 variant at (lcvX2−12,
  by+16, 24×24) following the glyph (v3.3 zone unchanged in the legacy bottom row); new valve glyphs ≥ 70 logical units from the
  T-301 B glyph (the phone test taps 64 units to its right). `drawStrip` bars = visible items with pitch 55 px for ≤ 5 bars
  (default, unchanged), 46 px for 6, 42 px for 7 (DS-101 sand, V-101, BUCKET, T-201, T-202, T-301A, T-301B; zones use the same
  pitch); the WHP cell adds "DS-101 ΔP" and the surge cell "T-201 · T-202" when in. All new canvas texts through `fmtU` /
  `fmtParts` (Metric).
- `summaryOf` → `WTS_state.sim`: `desander: {acc_frac, capt_lb, dumps, toChoke_lbd}`, `surge2: {frac, P}`, rig-up `extras`.

### 8.4 Rig-up card, reports, project files
- Rig-up card (`buildRig` L982 / `renderRig` L1002, rules in §3.4): switches come from `WTS_sim.RIGUP`. Intro text: "…the surge
  tanks transfer to the gauge tank on their own vessel pressure (LCV-201, LCV-202)". Keep the substring "T-201 → T-301 transfer"
  (SWEEP31); add "T-202 → T-301 transfer (LCV-202)" when in. **Status rows** (only while the item is in; the only live text that
  reaches the page PDF and the Quick Report): "DS-101: ΔP x psi (clean y) · cut z µm · capture w % · accumulator a % (b lb of c)
  · last dump T+hh:mm · rating r psi ✓ ≥ max SITHP s psig (estimated)" and "T-202: level x % · P y psig · route … · share s % ·
  LCV-202 …".
- Page PDF / PNG: automatic for the 2D canvas and the 3D snapshot (`__h2oilSnapshot`). No calcWTS result box is added.
- Project files: `wts_sim_rigup` carries the new keys (§3.4); multi-well keeps it per well (it is a `wts_*` key).
- Historian (C, host `simSamples` l.96856): tags `SIM.DS_ACC`, `SIM.DS_DP`, `SIM.SAND_CHOKE`, `SIM.T202_LEVEL`, `SIM.T202_P`.

### 8.5 Phone and iOS
- `renderVin` (L2729) no longer returns early for a one-valve item: T-202 inset (XV-202 open/shut, route buttons, LCV-202
  state); desander inset with a 44 × 44 px "Dump sand" (CSS rule L645 already sizes `.wtsl-vin .wtsl-b`), Resume / Abort while
  held, Bypass and Auto-dump. `openVin` aria labels per equipment; no inset opens for an item that is out (§8.0).
- No new `position:fixed` overlay (confirm box, card and inset are absolute inside `#wts_viz`; max mode already has the
  safe-area padding). If one is added, it needs an `html.ios-app` safe-area rule in `ios-additions/ios-styles.css`.
- New host inputs use `.fg-item` (16 px rule). three.js is bundled — no change. Run `sync-from-main.js` after the rebuild.

### 8.6 Mini WellOS and Modbus
Mini WellOS (`63-wellos.js`) draws `wtsDrawDiag(liveNodes(st), liveSegs(st))` without `opts` and runs the engine-default rig-up:
no visible change (legacy variants, §8.2); `liveNodes` returns 10 nodes (the diagram reads only the first 8); check its tests.
Modbus variables for T-202 / DS-101: follow-up (§1.2).

---

## 9. Tests

### 9.1 Existing tests that change
| File / check | Change | Owner |
|---|---|---|
| `tests/_harness.js` PIPELINE (L88-100) and header (L12-13, L88) | insert `['concat-round7','inject-round7']` after round 6, before round 8; header: "round 7 is rebuilt from 31/32/38 like the others" | WP0 |
| `wts3d-test.js` L202 | `RIGUP.length === 10`; RIGUP key set = RIG_KEYS set | E0 |
| `wts3d-test.js` L204, L210 | sig `'1111111100'`, `full === true`, `extras` empty | E0 |
| `wts3d-test.js` L211 | `getRigup()` JSON with 10 keys (`"desander":false,"surge2":false`) | E0 |
| `wts3d-test.js` L181 | exact `getControls()` JSON with `surge2`, `desander` | E0 |
| `wts3d-test.js` B READS list, fakeSnapshot paths | + new paths | 3D |
| `wts3d-test.js` valve proxies | + `valve:surge2:0`, `dump:desander`, `bypass:desander` | 3D |
| `wts3d-test.js` L298, L304 | 3D sig default `'11111100'`, `RIG_GROUPS` join, `'110101'` → `'11010100'` | 3D |
| `wts3d-test.js` L315 | `STEP` pins unchanged + `WTS_sim.stepFor` check (the four combinations of §3.5) | E0 (31) / 3D / L |
| `wts3d-test.js` L572-573 | "38 liveNodes(real) → **10** calc-shaped nodes with finite P/T" (`n.length === 10`) | ~~L~~ **E0** (done in `43d6b16`: the 38 foundation's `NODE_KEYS` made liveNodes return 10) |
| `wts3d-test.js` liveNodes / liveSegs names | `…\|Surge Tank\|Atm Tank\|Desander\|Surge Tank 2`, length 10; segs 6 | L |
| `wts3d-test.js` L473 | `rigItems().length === 10`; persistence: default request = no key; optional-only request stored | E0 (38 foundation) |
| `wts3d-test.js` host patch | `SAMPLE_FLOW` shape incl. `sim` keys; `runHostCalc` defaults for the 7 inputs; done markers | 2D |
| 31 self-tests 13, 26, 14 | 20 line names, segs 6; rig combos `{desander:true}`, `{surge2:true}`, `{surge2:true, surge:false}` (rule), balances, no trip; test 14 best of 2 | E0 (+E1/E2 add their combos) |
| 32 self-tests #6, #11, #13 | normalize defaults (no NaN with 10 nodes), fakeSnapshot schema / NULLABLE, framing | 3D |
| 38 self-test #5 | `n.length === 10`, names | ~~L~~ **E0** (done in `43d6b16`, same reason) |
| `tests/wts-rigup.test.js` L100, L112, L118, L242, L250 | RIG_KEYS list (10); default `full`, empty notes, sig `'1111111100'`; live view test adds the two switches; "T-201 out forces T-202 out (note) and the dumps go to T-301"; default card shows 'Full rig-up' with the button disabled | E0 / L |
| `tests/wts-v31.test.js` L176 | card list + `'desander','surge2'`; assert `desander:ds-dump\|` pressed | L |
| `tests/wts-v31.test.js` rig-up switch loop (L243-253) | optional switches start out: toggle in, then back (`!was` / `was`) | **E0** (done in `43d6b16`: the foundation's optional switches broke the "toggle out" pin) |
| `tests/sweep-fixes-v31.test.js` (SWEEP31 Metric) | new canvas texts convert; row label substring kept | L / 2D |
| `tests/wts-divert*.test.js` | re-run; `bx` offsets unchanged in every variant | 2D |
| `tests/wts-divert.test.js` exact `getControls()` shape (L241-246) | + `surge2`, `desander` defaults | **E0** (done in `43d6b16`: new controls keys) |
| `tests/ios-native.test.js` | passes once the version stamps are the release version | lead |

### 9.2 New tests and tools
- **`prism-build/tests/_wts-sim-v33.js`** (WP0, never edited): verbatim `31-wts-sim.js` at `666be77` with the self-test
  stripped (`stripSelfTest` of `concat-round7.js`), header comment naming its origin. Used by the identity tests and
  `wts-sim-perf.js`. Loaded in its own vm context (both define `WTS_sim`).
- **`prism-build/wts-sim-perf.js`** (WP0, tool): §7 A/B gate; `--pairs n` (default 10), `--json`.
- **Harness self-check** (WP0, in `wts-equipment.test.js`): a test with `opts.sourceOverrides: {'31-wts-sim.js': <working 31 with
  VERSION replaced by '9.9.9-probe'>}` sees `WTS_sim.VERSION === '9.9.9-probe'` (proves Round 7 overrides reach the app); a
  second test: on the unchanged tree the `--sources` main script equals the `--html` main script (Round 7 inject is idempotent).
- **`tests/wts-equipment.test.js`** (WP0 / E0, lead extends at integration; ≈ 20 tests): rig-up defaults; v3.3 8-key requests →
  both out; strings / null / missing → out for optional; `surge2` without `surge` → forced out with the note; `setRigup({x:null})`
  → default; sig / `full` / `extras`; `RIG_TXT` for every key; **frozen-engine identity** — scenarios (a) 4 h default at dt 10,
  (b) 1 h for each single core removal, (c) a T-201 A/B divert scenario, (d) `oilDumpStuckOpen` and `xferStuckClosed`, (e) one
  ESD trip and reset — run on `_wts-sim-v33.js` and on the new engine (with the v3.3 `SAMPLE_FLOW`, and again with the new one
  carrying the seven default `sim` keys): every v3.3 path `===`, sig rule as §7 (U6); contract vs `_wts-equip-shapes.js`;
  `stepFor` combinations; finite walk + NULLABLE with both in and flow-back on; determinism (same seed) with both in; step-size dt
  1 vs 10; 38 `readRig/writeRig/applyFlow/fullRig` round trips with v3.3 and v3.3.1 objects; `renderRig` default ('Full rig-up',
  button disabled, `collectPageReport` contains no DS-101 / T-202 rows).
- **`tests/wts-desander.test.js`** (E1; ≈ 32 tests):
  - pure helpers vs research: E_tot table cells ± 0.2 %; DNV reducer example 8.72 mm/yr ± 1 %; `dp(14.17, 20.7)` = 3.93 psi and
    `dp(55, 30)` = 32.1 psi ± 0.5 %; `c2`, `mixSound` (no liquid term at GVF 1), `muGas` against three reference values computed with
    the 16-pvt.js Lee-Gonzalez-Eakin function;
  - §4.9 anchors on SAMPLE_FLOW (ΔP 3.93 ± 2 %, v_in 20.7, d50c 39.8 ± 1 µm, E 0.946 ± 0.005, C2 passed 0.110 ± 3 %, Up 888 ± 3 %,
    erosion 1,594 / 23.6 mpy ± 5 % and bands warn / ok);
  - finite walk with **dry gas** (Qo = Qw = 0, 5 lb/MMscf: gas carrier, no NaN anywhere) and **zero rate** (segs[1].vel = 0:
    desander block skipped, ΔP 0, eff 0); `1e400` through `flow.sim` is clamped;
  - choke inlet lower by PD (`nodes.esd.P − nodes.choke.Pin = dP` within 0.05 psi after 60 s) and **no spike** on `nodes.esd.P`
    when the bypass toggles (max deviation < 0.1 psi);
  - sand balance exact (`massErr.sand` < 1e−9 relative, three identities of §4.4); flow-back reaches LAH at 3.50 h ± 5 %;
    flow-back term scales with `min(1.5, fI)^1.5` (× 0.354 at fI 0.5); LAHH lowers capture;
  - dump: phase order; flush starts at 8 + 307 ± 2 s (interlock 1); equalise lasts 147 ± 3 s at PB 10,000 psig (interlock 2);
    total 1,043 ± 3 s on the sample; accumulator → 0, buffer → accumulator capped; refused when out / running / ESD tripped; abort
    on rig-out; `desanderIsoPassing` → `DES_DUMP_FAIL` 'accumulator not bled', `P_acc` never < 50 psig, nothing removed;
    `desanderDumpStuck` → `DES_DUMP_FAIL`, auto-dump blocked until the next manual start; **overflow**: stuck fault + three dumps
    in flow-back → acc ≤ cap and capt ≥ 0 at every substep, balance exact;
  - **ESD hold**: ESD mid-flush → phase `held`, XV-103 shut; resume refused before the reset; after the reset resume completes,
    abort returns the buffer (capped);
  - `desanderPlugged` on **SAMPLE_FLOW** → `DES_DP_HIGH` within 60 s; washout → `DES_DP_LOW`; `desanderBypassPassing` → capture ×
    0.9, no PDAL; bypass → ΔP 0, all sand to the choke, `SAND_CHOKE`; flow-back bypassed → band high and `SAND_SEP` once the bulk
    volume passes 10 %; sand off → `SAND_CHOKE` / `SAND_SEP` clear at once (`quiet(Q_SAND)`);
  - rating: 5,000 psi with `sithp_psig` 5,200 → `DES_RATING` (alarm); 5,000 psi with FWHT 260 °F → `DES_RATING` (temperature);
    blank SITHP → estimated 1.2 × WHP and the '(estimated)' text; Pwh 5,200 psig flowing with a 5,000 psi rating → `DES_PSHH` trip
    and ESD; **no other desander alarm trips the ESD**;
  - `DES_RATE` below turndown at 30 % rate after startupGrace, not during start-up; `HYD_desander`, `HYD_dsAcc` (cold ambient),
    `HYD_dsBleed` (Twh 120 °F) flags;
  - choke coupling (if built): plugged desander on a liquid case scales the rate by √ΔP; near the gas limit sets `flowLimited`
    with hysteresis (no flicker in 600 s of noise); `qgE/qoE/qwE` unchanged after 10,000 substeps.
- **`tests/wts-surge2.test.js`** (E2; ≈ 26 tests): starts empty, XV-202 shut; routes (make-before-break, no `SURGE_BLOCKED`
  during a switch); **pressure-driven split** — equal pressures → shares ≈ 50 / 50, PCV-203 stuck closed with route 'both' →
  T-202's share falls as Pu2 rises, no branch flow ever negative, Ph ≥ min(P_k); LCV-202 law `q = liqQ(Cv, ΔP, SG)` and lsh / lsl
  cycling; T-301 receives the sum; **LSHH-202** closes XV-202 with no ESD (route 'both': dumps continue into T-201; route
  'surge2': `SURGE_BLOCKED` → LSHH-102 → ESD); LSLL-202 latches `XFER2_DRYRUN`, reset via `resetTrip`; `XFER2_DRYRUN` latched →
  `resetESD` succeeds and `esd.blocking` is empty; LSHH-301 shuts LCV-201 and LCV-202; oil / water / gas balance < 1e−6 over 4 h
  with route switches; **gas accounting direct**: gauge-tank flash rate = Σ po_k·Rs(P_k), GOR on route T-202 within 1 % of route
  T-201 at equal set points, shrink uses the transfer-weighted BoR; PCV-203 holds SP ± 1 psi (**acceptance measure, WP-I**:
  mean |P − SP| ≤ 1 psi and peak ≤ PCV-201's peak on the same workload + 0.5 psi — see the note after this list); `bpv2StuckClosed` → PAH-202 →
  PSHH-202 → XV-202 shut, PCV-204 held shut, ESD; **removal while tripped**: PCV-203 stuck closed → PSHH-202 trip → remove T-202
  → `resetESD` succeeds; **PSV-202**: `Cv_psvU2` relieves each sizing case at 1.10·mawpU2 (via `_internal`), and
  `oilDumpStuckOpen` on route 'surge2' keeps Pu2 ≤ 1.10·mawpU2 throughout (PSV-202 lifts if PSHH-202's closure has not yet
  stopped the inflow); `xfer2StuckClosed` → `XFER2_FAIL`; T-202 out with liquid → frozen inventory, balance holds, back in →
  same inventory; **T-202 leaving as the only route** → XV-201A/B snapped open and logged; with both T-201 compartments at
  LSHH-201 → refused with the note; auto route at `sp`; `LAH_SURGE_BOTH` suppressed while the auto route has room,
  `LAH_SURGE_ALL` when all are high; `getControls/setControls` round trip with v3.3 prefs (no `surge2` key); saved prefs with
  `inlet:true` restore XV-202 open at session start, adding T-202 from the card snaps it shut; no gauge tank → LCV-202 to export.
- **`tests/wts-equipment-views.test.js`** (L + 2D, integration; ≈ 22 tests). Before WP-I the call contract is checked with a
  **recording stub sim** (`WTS_live._internals.useSim(stub)`) and the visible result through `fakeEquipSnapshot`; the lead adds
  the engine-backed end-to-end versions at WP-I. Switches on the Rig-up card; 2D draws 'Desander', 'T-202', sand %, XV-202 /
  LCV-202 glyphs only when in, and with both out the 2D canvas command stream equals the v3.3 one (legacy variants); XV-202 click
  calls `setValve('surge2', 0, …)` (never a T-301 valve); 3D `onAction {type:'valve', eq:'surge2', idx:0}` routes to T-202;
  "Dump sand" from the card, the 2D glyph and the 375 px inset (44 px button) calls `dumpDesander` once after the confirm; Resume
  / Abort while held; HUD / popovers / strip show T-202 and DS-101 without NaN; strip pitch 55 px by default; Metric canvas has no
  psig / lb / gal / mpy / mil/d; page report contains the DS-101 and T-202 Rig-up rows when in and none when out; reload
  restores the rig-up; Scenarios menu length = `WTS_sim.FAULTS.length` with the v3.3 entries first in v3.3 order; with both
  items out: the phone tap at the DS slot opens nothing, `zones2d` has no DS / T-202 entry.
- **`wts3d-test.js` new checks** (3D; ≈ 14): clearance test on rendered primitives (§8.1; `PROPS` from `_internals`); every
  `EQ_IDS` id present in `TAGS / TITLES / PREF_SIDE / ANCHORS / HALO / EQ_BOX`; every new route endpoint lies on a route or a
  tee; `nextS[X0]` equals X2's arc length to the elbow; with both items out: `pickAt` at the DS-101 and T-202 screen positions
  returns the v3.3 value, `occlusion()` results equal, the Wellhead / Tanks camera equals v3.3, the tracer allocation per chain
  is unchanged; label layout: project `ANCHORS` with the default overview camera at 1380 × 700 and run `layoutLabels` with DS-101
  and T-202 in — no equipment chip hidden (hiding accepted at phone width); scene builds and frames with each of the 4 optional
  combinations (existing framing gate, V-101 ≥ 55 × 170 px) at 1380 × 700 and 375 × 812 with the HUD heights measured after the
  `tDs` line (**WP-I, measured with Playwright on the Round-7 build, both items in and out — identical**: at 1380 px the HUD
  stays 56 px, insets 98 / 76; on a 375 × 812 phone (sm) the toolbar (48 px) and HUD tiles (128 px) sit outside the stage, the
  3D view is 345 × 471 on the page and 375 × 620 maximised, insets 8 / 8; the gate uses those two views — the earlier 375 × 812
  model with insets 233 / 108 is retired; 38 exports no separate HUD metrics, `_debug.insets()` is the source); a rig-up change does not move the camera when `userMoved` is true.
- Expected counts after integration: smoke 326 (unchanged — it checks namespaces and the `wtsDrawDiag` bridge); accept ≈ 1,162 +
  100; wts3d-test ≈ 101 + 14.
- **PCV-203 acceptance measure (WP-I, measured 2026-11-06 on the integrated engine):** `SAMPLE_FLOW`, T-202 in, SP 25 psig,
  1800 s settle then 4 h sampled at dt 5 s, |P − SPeff| of T-202 against the same run's T-201 with T-202 out (PCV-201):
  route T-202 mean 0.44 / p95 1.71 / peak 1.93 psi (PCV-201: 0.445 / 1.71 / 1.94); route both 0.16 / 1.61 / 1.95; the same with
  noise on and at dt 1 s (0.44 / 1.71 / 1.94). The dump cycles move both back-pressure valves by up to about 2 psi for a few
  seconds, so a literal ± 1 psi peak is not what PCV-201 does either; the acceptance measure is mean ≤ 1 psi and peak ≤ the
  PCV-201 peak + 0.5 psi (`wts-surge2` 'PCV-203 holds the set point ± 1 psi').

### 9.3 GUI sweep (`gui-sweep.js`, owned by WP-L)
Run job `simJob` (L988-1032): after the fault loop (which turns each fault on and leaves it on, L1019-1026), **reload the page**
(or Reset and clear every fault) so no fault is left active; switch DS-101 and T-202 into the rig-up from the Rig-up card, set
Sand rate, open the DS-101 card, press "Dump sand" + confirm, route the dumps to T-202, run at **×600 for ≥ 3 s** (≥ 1,800 s of sim
time, longer than the ≈ 1,043 s dump) and assert the DS-101 card shows a completed dump (count 1); then restore the rig-up
(it persists across reloads in `wts_sim_rigup`). Findings: no console error, no NaN / undefined text, the clock advances, the
Scenarios menu lists every engine fault. `DESTRUCTIVE` needs no change (the dump is confirmed). Expectation: **no new error or
warning findings** in `--route wts` and `--mobile` (review: the inputs stay untagged — imperial labels in Metric mode, including Max
SITHP (psig) and Desander rating (psi) while the DS-101 card shows kPa; the µm unit is kept lower case); cosmetic imperial-label findings for the untagged inputs (lb/1000 bbl,
lb/MMscf, gal, bbl, psig) are accepted, as for the existing Dynamic Simulation inputs.

### 9.4 Browser checks before release (lead)
Default overview at 1380 × 700 and 375 × 812 (3D + 2D) compared with v3.3 screenshots (must match with both items out), Wellhead
and Tanks views, labels All / Equipment, each of the 4 optional combinations × T-201 in / out, a dump while running at ×60
(including an ESD mid-dump, resume and abort), the flow-back scenario to LAH, bypass on / off, Metric mode, decimal comma. Then
`node prism-build/gui-sweep.js --route wts` and `--mobile`.

---

## 10. Work packages

### 10.1 Packages, order and owners
| WP | Owner | Depends on | Content | Gate |
|---|---|---|---|---|
| **WP0** contract, harness, frozen engine | lead | — | Create branch `sim-equip` from `Dev`. `tests/_harness.js` Round-7 pipeline + header; `tests/_wts-sim-v33.js`; `prism-build/wts-sim-perf.js` (baseline run recorded in the WP notes); `tests/_wts-equip-shapes.js` (§6.11, incl. `stepFor` combinations and action payloads); the harness self-check tests; this plan | `accept-test.js --sources` = `--html` main script on the unchanged tree; full accept suite green in `--sources`; fixture reviewed |
| **WP-E0** foundation | builder A | WP0 | **31:** rig-up model (§3.1–3.3 except the WP-E1/E2 behaviours), `stepFor`, all constant appends for both items (TAGS, NAMES, FAULT_IDS/LABELS, HIST_KEYS, line names, NULLABLE, DEFAULTS, `flowDerived` with clamps, `SAMPLE_FLOW.sim`), exports (`RIG_DEFAULTS`, `RIG_OPTIONAL`, VERSION 1.4.0), snapshot blocks with static placeholders, `ctl.surge2/desander` in get/setControls, `blockingNow` / snapshot blocking `!A.act`, API stubs (`dumpDesander` → `{ok:false, msg:'not available yet'}`, `setSurgeRoute`, `setDesander`, `setValve('surge2')` → false), **two labelled stub sections** `// ─── DS-101 desander + sand (WP-E1) ───` and `// ─── T-202 second surge tank (WP-E2) ───` with empty, guarded hooks and their call sites: `desDerive/surge2Derive`, `desInit/surge2Init`, `surge2Limits`, `desStep/surge2Step`, `desAlarms/surge2Alarms`, `desRefresh/surge2Refresh`, `desChooseH/surge2ChooseH`, `desHist/surge2Hist`, `desBalance/surge2Inv` (inventories, `setRef`, `zeroCum`, `massErr`), `desRig/surge2Rig` (setRigNow), and an `_internal` extension point (`desInternal/surge2Internal`); self-tests 13/26/14; wts3d-test engine pins. **38 foundation** (§8.3 first bullet, §3.4). `wts-rigup.test.js` engine part; `wts-equipment.test.js` | every existing test green; frozen-engine identity; `wts-sim-perf.js` ≤ 1.05 |
| **WP-E1** desander + sand + erosion | builder A | WP-E0 | 31 desander section and its hooks, upstream PB / PBu / PD lines (L1594-1595), `refresh` esd / choke / desander node lines (L1812–1817), `designAlarms` `hn` list, `sand` helpers, dump sequence with interlocks and hold, bypass line-up, faults, alarms, PSHH-103, sand to separator, choke coupling (S); `tests/wts-desander.test.js` | its tests; identity; perf |
| **WP-E2** T-202 | builder B | WP-E0 | 31 T-202 section and its hooks, the shared-code list of §5.8; `tests/wts-surge2.test.js` | its tests; identity; perf |
| **WP-3D** 3D scene | builder C | WP0 (fixture), WP-E0 for the live run | 32 everything in §8.0–8.1 incl. the `stepFor` fallback; wts3d-test 3D checks + clearance and label tests; 32 self-tests | wts3d-test 3D section; framing gate (4 combinations, two sizes) |
| **WP-L** HMI | builder D | WP0, WP-E0 | 38 except the foundation and the 2D overlay functions: `EQV` use sites, cards / actions / confirm / hold, HUD / tiles / popovers / trends / legend, Scenarios menu, phone inset, `summaryOf`, toasts; `gui-sweep.js` run job; `ux-layout-check.js` if HUD heights move; tests in §9.1 marked L; `wts-equipment-views.test.js` (HMI part, stub sim) | its tests |
| **WP-2D** 2D | builder E | WP0, WP-E0 (38 foundation) | host `wtsDrawDiag` variants / `WTS_DIAG_LAYOUT` / Dynamic Simulation inputs / `WTS_IDS` / `flow.sim`; 38 `draw2dLive`, `drawRig2d`, `RIG2D`, `drawStrip`, `valves2d`, `zones2d`, `nearValve` and the 2D click branch of `onClick`; host historian tags (C); `wts-equipment-views.test.js` (2D part, stub sim); host-patch checks | its tests; divert glyph tests |
| **WP-I** integration + release | lead | all | merge on `sim-equip`, Round-7 rebuild, engine-backed view tests, full suite, perf, GUI sweep, browser checks, release items (§11), docs; then merge `sim-equip` → `Dev` | §10.5 all green |

Builders A and B can be the same person (E1 then E2) if only one engine builder is available; the plan then loses about one day.

**Hook signatures as built by WP-E0 (confirmed by the lead; these replace the names in the WP-E0 row above).** The section
headers in `31-wts-sim.js` list each hook with its call site; E1 / E2 fill the bodies and keep the signatures.
- Shared by both: `desDerive()` / `surge2Derive()`, `desInit()` / `surge2Init()`, `surge2Limits(h)`, `desStep(h, fEn)` /
  `surge2Step(h)`, `desAlarms()` / `surge2Alarms()`, `desRefresh(s)` / `surge2Refresh(s)`, `desHist(i)` / `surge2Hist(i)`,
  `desInternal(o)` / `surge2Internal(o)`.
- `desChooseH(c)` / `surge2ChooseH(c)`: both receive one shared object `c = {h, te}` per `chooseH` call (step cap and time to
  the next event) and may only lower `c.h` / `c.te`.
- Balances by op code: `desBalance(op, o)` (`'zero'` o = cum, `'ref'` o = ref, `'err'` → `health.massErr.sand`);
  `surge2Inv(op, o)` (`'oil'` STB / `'water'` bbl / `'gas'` scf inventory in every balance; `'zero'`, `'ref'`).
- Rig-up by phase: `desRig(phase, old, r, parts)` / `surge2Rig(…)` — `'check'` returns the refusal text (`''` = allowed, before
  anything changes); `'apply'` runs when the item enters / leaves and may push to `parts` (§3.3).
- API hooks (added by WP-E0, not in the first list): `desFault(id, on)`, `desCtl(src, initial)`, `desDump(cmd)` → `{ok, msg}`,
  `desSet(o)` → bool; `surge2Valve(open, isAuto)` → bool, `surge2Route(mode)` → `{ok, msg}`, `surge2Auto(on, o)` → bool,
  `surge2Opts(o)` → bool, `surge2Ctl(src, initial)`.
- Constants: `Q_DES`, `Q_SAND`, `Q_SURGE2` are declared by WP-E0 next to `Q_SEP` / `Q_SURGE` / `Q_GAUGE` (equal to the fixture
  lists). The alarm **MSG** texts of the new alarms are not constants: each package adds its own entries inside its own section
  (`MSG.DES_DP_HIGH = function (v, l) { … };` as a statement in the section, which runs after `MSG` is created). Any other new
  constant goes to the lead (§10.2).

**Exit items (tracked; the package does not finish until it is gone):**
- WP-3D removes the interim allowance in `wts3d-test.js` that lets 32's `NULLABLE` copy lack the three new paths (§6.10).
- WP-2D removes the interim allowance in `wts3d-test.js` that lets the host `flow.sim` lack the seven new keys (§6.3).
Both are marked in the code ("interim allowance").
WP-L and WP-2D no longer depend on each other (the `noSurge` refactor is dropped).

### 10.2 File ownership
| File | Owner (others must not edit) |
|---|---|
| `prism-build/31-wts-sim.js` | WP-E0 (all constants, rig-up, contract, hooks); then WP-E1 (desander section + its hooks + the upstream / node lines listed above) and WP-E2 (T-202 section + its hooks + §5.8 lines). Neither E1 nor E2 edits constants, another section or another package's hook body; a missing constant or hook goes to the lead |
| `prism-build/32-wts-3d.js` | WP-3D |
| `prism-build/38-wts-live.js` | WP-E0 (foundation: constants, rig persistence, `renderRig` predicates, `EQV`, `rigIn`, `stepFor` fallback, test hooks); then WP-L, except `draw2dLive`, `drawRig2d`, `RIG2D`, `drawStrip`, `valves2d`, `zones2d`, `nearValve`, 2D click branch → WP-2D |
| `well-testing-app.html` | WP-2D (2D schematic, Dynamic Simulation card, `WTS_IDS`, `flow.sim`, historian tags); lead (`RELEASE_NOTES`, `#appVersionLabel` fallback) |
| `prism-build/wts-host-patch.js` | WP-2D, only if a done marker must change (avoid) |
| `prism-build/wts3d-test.js` | sections: E0 (31 engine, 38 persistence), 3D (32), L (38), 2D (host patch); the lead merges |
| `prism-build/tests/_harness.js`, `tests/_wts-sim-v33.js`, `wts-sim-perf.js`, `tests/_wts-equip-shapes.js` | WP0 / lead |
| `prism-build/tests/wts-rigup.test.js` | E0 (engine, persistence), L (live view) |
| `prism-build/tests/wts-equipment.test.js` | WP0 / E0 / lead |
| `prism-build/tests/wts-desander.test.js` | E1 |
| `prism-build/tests/wts-surge2.test.js` | E2 |
| `prism-build/tests/wts-equipment-views.test.js` | L and 2D (separate groups in one array), lead merges and adds the engine-backed versions |
| `prism-build/tests/wts-v31.test.js`, `sweep-fixes-v31.test.js`, `gui-sweep.js`, `ux-layout-check.js` | WP-L |
| `prism-build/tests/wts-divert*.test.js` | WP-2D (only if glyph offsets change — they must not) |
| iOS version stamps, `README.md`, `CLAUDE.md`, `PROJECT-NOTES.md`, `docs/SIM-EQUIPMENT-PLAN.md`, `perf-baseline.json` (only if an increase is intended) | lead |
| Generated: `combined-round7.js`, `ios-app/www/index.html` | integration only (never by hand) |

### 10.3 Rules for parallel worktrees
- One worktree and branch per WP from **`sim-equip`** after WP-E0 is merged into it (WP-3D may start from WP0 and rebase on
  WP-E0). Nothing is merged into `Dev` before WP-I.
- Builders do not run `inject-round7.js` on the HTML or edit the host's injected Round-7 block. After WP0 the harness rebuilds
  Round 7 in memory from 31/32/38, so they test with `node prism-build/accept-test.js --sources` (and `opts.sourceOverrides` work
  for 31/32/38) and `node prism-build/wts3d-test.js`. **Until WP0 has merged, the only valid gate for 31/32/38 changes is
  `wts3d-test.js`** (`--sources` would run the v3.3 copies injected in the HTML).
- **On `sim-equip` until the WP-I rebuild, the gate is `accept-test.js --sources` plus `wts3d-test.js` (and `wts-sim-perf.js`
  for 31).** `--html` loads the committed HTML, whose Round 7 is still v3.3, so `--html --integration --grep WTS` fails the E0 /
  WTSRIG tests and the WTSDV persistence test by design (8 of 81 at WP-E0); the CLAUDE.md `--html` gate applies again after WP-I.
- WP-E0 also edited test lines owned by WP-L and WP-2D (§9.1, marked E0). WP-L and WP-2D branch from `sim-equip` at or after
  WP-E0 (`43d6b16`) and its review fixes, or rebase on it before they start.
- Advance `sim-equip` only from the worktree that has it checked out (`git merge --ff-only <wp-branch>` there). Never move it
  with `update-ref` / `branch -f` while another worktree has it checked out: that worktree's index then undoes the move.
- View builders code against `_wts-equip-shapes.js` / `fakeEquipSnapshot` and the recording stub sim; nothing may depend on
  engine internals (`_internal`).
- ES5 style as the existing files (`var`, `function`; no `??`, `?.`, `=>`; no `let` / `const` in 31/32).
- No timers, polling or function wrapping; field units; no names of other companies, products or websites (correlations and
  standards by author / designation only; no eponym for the mixture speed of sound); never write the competitor abbreviation
  listed in CLAUDE.md.

### 10.4 Merge order and integration (lead)
On `sim-equip`: WP-E0 → WP-E1 → WP-E2 (resolve hook-body conflicts — there should be none, since each package fills its own hooks;
re-run identity) → WP-3D → WP-L → WP-2D. After each merge: `accept-test --sources --grep wts`, `wts3d-test.js`,
`wts-sim-perf.js`. Then the Round-7 rebuild (§10.5), engine-backed view tests, the full suite, perf, GUI sweep, browser checks
(§9.4), release items (§11). Then merge `sim-equip` → `Dev` with `--no-ff`, push `Dev`, and merge `Dev` → `master` once verified
(CLAUDE.md branch model; resolve `ios-app/www/index.html` with Dev's copy). A Round-7 rebuild on `Dev` by parallel work (for
example DFIT v3.4) therefore never ships half-built equipment.

### 10.5 Rebuild and verification (Linux checkout: LF; Windows working copy: re-normalise CRLF as CLAUDE.md step 7)
```bash
N=node   # Windows: the node.exe path in CLAUDE.md
$N prism-build/concat-round7.js && $N prism-build/inject-round7.js && \
$N -e "const s=require('fs').readFileSync('well-testing-app.html','utf8');if(/\r/.test(s))throw new Error('CR in an LF checkout')" && \
$N ios-app/scripts/sync-from-main.js && \
$N -e "
const fs=require('fs');const html=fs.readFileSync('well-testing-app.html','utf8');
const m=html.match(/<script>\\s*\\/\\* ═+\\s*WELL TESTING SUITE([\\s\\S]+?)<\\/script>/);
fs.writeFileSync('prism-build/.tmp/wts-main.js','/* ═══ WELL TESTING SUITE'+m[1],'utf8');" && \
$N --check prism-build/.tmp/wts-main.js && \
$N prism-build/smoke-test.js | tail -3 && \
$N prism-build/accept-test.js --html --integration | tail -3 && \
$N prism-build/accept-test.js --sources | tail -3 && \
$N prism-build/wts3d-test.js | tail -5 && \
$N prism-build/wts-sim-perf.js && \
$N prism-build/perf-budget.js | tail -5        # wts3d: on an LF checkout the two CRLF checks fail (documented)
```
Only Round 7 and direct host edits change; once, at the end, run the CLAUDE.md full incantation **with** the Round-7 pair added
and check that `git diff --stat` touches only the expected files.

---

## 11. Release items (lead, WP-I)
- **Version rule:** at WP-I set the version to the next point release after the `RELEASE_NOTES[0].ver` current then (**3.3.1**
  if v3.4 has not shipped; otherwise e.g. 3.4.1), and use that one value in all of: `RELEASE_NOTES[0].ver`, both
  `MARKETING_VERSION` entries, both `VERSION_BASE` copies, and the static `#appVersionLabel` fallback in the host HTML (L707,
  "Well Testing Suite v3.3", updated for v3.3 in `666be77`). The text below uses 3.3.1.
- `RELEASE_NOTES` new first entry (the version under the logo follows it):
  ```
  { ver:'v3.3.1', date:'<release date>', title:'Simulator: second surge tank &amp; cyclonic desander',
    note:'Two new optional items for the Well Test Simulator rig-up: a second surge tank and a cyclonic desander upstream of the choke. With both left out the simulator runs and looks as before; the Dynamic Simulation card has new sand and equipment inputs.',
    items:[
      ['new', 'Cyclonic desander', 'DS-101 can be added to the rig-up between SDV-101 and the choke. Its pressure drop, cut size and sand capture follow the flow; the accumulator fills and is dumped from its card with the interlocked isolate, bleed, flush, equalise and reopen sequence while the well keeps flowing (held on an ESD trip, then resumed or aborted), with optional auto-dump, a bypass line-up, LAH / LAHH, ΔP and rating alarms and a high-pressure trip.'],
      ['new', 'Second surge tank', 'T-202 can be added next to T-201 with its own back-pressure valve, blanket, relief valve, level alarms and LCV-202 transfer to the gauge tank. The separator dumps go to T-201, T-202 or both (make-before-break, split by vessel pressure through check valves), with an optional automatic switch when T-201 is full.'],
      ['calc', 'Sand in the well stream', 'Sand rate (liquid and gas) and size inputs and a sand / proppant flow-back scenario; the sand reaching the choke and the separator and a steel-equivalent choke erosion rate (screening, per day of test) show the effect of the desander.'],
      ['report', 'Rig-up card', 'The Rig-up card lists the desander and second surge tank status when they are in the rig-up, so they appear in the page report and the Quick Report. The App Store version is 3.3.1.'],
      ['ux', 'Simulator scenarios', 'The Scenarios menu lists every simulator scenario, including sand flow-back and the new desander and T-202 faults, after the existing ones.'] ] }
  ```
- `ios-app/ios/App/App.xcodeproj/project.pbxproj`: both `MARKETING_VERSION = 3.3.1;`.
- `ios-app/ci_scripts/ci_post_clone.sh` and `ios-app/ios/App/ci_scripts/ci_post_clone.sh`: `VERSION_BASE="3.3.1"` (keep both
  copies identical; `tests/ios-native.test.js` checks them against `RELEASE_NOTES[0].ver`).
- Host `#appVersionLabel` fallback (L707): "Well Testing Suite v3.3.1".
- `WTS_sim.VERSION = '1.4.0'`.
- `README.md`: simulator line gains "optional second surge tank and cyclonic desander (upstream of the choke) with sand and choke
  erosion screening".
- `CLAUDE.md`: Round-7 file-map line (31: T-202, DS-101, sand, rig-up optional items with defaults, `stepFor`; 32/38 views);
  **test harness note** (`tests/_harness.js` now rebuilds Round 7 in memory like the PRiSM rounds — "Round-7 belongs to a separate
  workstream, never run it from PRiSM work" still holds for the build incantation; `tests/_wts-sim-v33.js` is a frozen fixture;
  `wts-sim-perf.js` is the simulator A/B perf gate); Known limitations (desander assumptions: f_lo / f_hi / f_g, fill knee,
  flow-back profile and PSD; erosion is steel-equivalent display only with an assumed 125 mil / 72 h band basis; bleed / flush
  volumes not in the balances; T-202 split pressure-driven with a one-substep header lag; PSHH-201 keeps the ESD-only action;
  PSV fire case not modelled; sand stops at V-101, no LCV erosion / plugging); stats (accept count, wts3d count); latest release.
- `PROJECT-NOTES.md`: newest-on-top entry.
- Verification list (§10.5) includes `wts-sim-perf.js` and `perf-budget.js`.

---

## 12. Open questions — chosen defaults (builders do not stop to ask)
| # | Question | Chosen default |
|---|---|---|
| Q1 | Default rig-up state of the new items | Out (optional, D1) |
| Q2 | Default sand rate | 0 (engine and host); flow-back scenario and card hint (D6) |
| Q3 | T-202 tags (PCV-202 clash) | PCV-203 BPV, PCV-204 blanket; rest on loop 202 (D12) |
| Q4 | T-202 without T-201 | Not allowed; forced out with a note (D11) |
| Q5 | LSHH-202 action | Close XV-202, **no ESD** (`act:'xv202'`); the ESD follows only through `SURGE_BLOCKED` → LSHH-102 when no other inlet is open. PSHH-202: close XV-202, hold PCV-204 shut, then ESD |
| Q6 | Shared or own back-pressure valve | Own PCV-203; set point follows T-201 unless configured |
| Q7 | T-202 outlet | Own LCV-202 into the common transfer line (D13) |
| Q8 | Inlet split with both open | Pressure-driven with a check valve per branch; A/B inside T-201 by position (D14) |
| Q9 | Dump durations | Published sequence (8 / ≥ 300 / 600 / ≥ 120 / 8 s, ≈ 17 min), phases gated by the interlocks, configurable |
| Q10 | Bleed gas and flush water | Visual only, not in the balances (stated limitation) |
| Q11 | Erosion indicator basis | DNV-RP-O501 reducer model, steel constants, passed-sand C2, throat-pressure gas velocity, mil/d bands on a 125 mil / 72 h basis, screening label, no feedback (D9) |
| Q12 | Choke capacity coupling | Should; gated on DS-101 in; local copies; critical gas and √ΔP liquid laws (D10) |
| Q13 | Step numbers | `WTS_sim.stepFor(rigup)`; default numbering unchanged (D17) |
| Q14 | 2D layout | Two fixed variants per row; the v3.3 row while its item is out (§8.2) |
| Q15 | Optional items when out | Hidden, not ghosted, no volume in any view table (D18, §8.0) |
| Q16 | Auto-dump / auto route | Both available, both off by default; auto-dump blocked after a failed dump |
| Q17 | "Full rig-up" button | Core items in; optional items unchanged; disabled test over core items |
| Q18 | Desander rating input | Select 5,000 / 10,000 / 15,000 psi, default 10,000; checked against the max SITHP input (estimated 1.2 × WHP when blank) and the temperature class; `DES_RATING` is an alarm |
| Q19 | Desander alarms and the ESD | No desander alarm trips the ESD **except PSHH-103** (inlet ≥ rating while flowing) |
| Q20 | Sand rate vs flow | W_ss·fInst^1.5; flow-back term × min(1.5, fInst)^1.5 (ASSUMPTION; bean-up raises sand, bean-back lowers it) |
| Q21 | Carrier viscosity for the cut size | Dead-oil correlation at the desander temperature blended with water by water cut (conservative); gas viscosity (Lee-Gonzalez-Eakin) when there is no liquid |
| Q22 | Persist bypass / auto settings | Yes, in device prefs with the other valve controls (`h2viz3d_prefs.ctl`) |
| Q23 | Acoustic sand monitor | Could (C); deferred unless WP-E1 has time |
| Q24 | Modbus / Mini WellOS tags | Follow-up release |
| Q25 | API name for the dump | `dumpDesander(cmd)`; UI "Dump sand"; `data-act="ds-dump"` (+ `ds-resume`, `ds-abort`); event `'dump'`; log id `DS_DUMP` |
| Q26 | Max SITHP input location | `flow.sim.sithp_psig` → `cfg.desander.sithp_psig` (design value only; the build-up curve keeps `sithpFactor`) |
| Q27 | T-202 leaving while it is the only open route | Snap XV-201A/B open (logged) before disconnecting; refuse when T-201 cannot take the dumps |
| Q28 | Saved line-up vs adding T-202 | Prefs restore the line-up at session start; adding T-202 from the card snaps XV-202 shut |
| Q29 | Scenarios menu order | v3.3 entries first in v3.3 order with their v3.3 labels, then new engine ids |
| Q30 | Gas sand input in the host | Yes, `wts_sandGas` (lb/MMscf), so a dry-gas well can carry sand from the form |
| Q31 | Release version | Next point release after the current `RELEASE_NOTES[0].ver`, fixed at WP-I |

---

## Appendix A — current-tree line references used by this plan (v3.3, `666be77`)
- `31-wts-sim.js`: TAGS L107-112, NULLABLE L116-118, FAULT_IDS / FAULT_LABELS L120-123, RIG_KEYS L125, RIG_ITEMS L126-134, normRigup
  L137-155 (full L154), NODE_IDS L156, SEG_META L157-158, HIST_KEYS L159-160, DEFAULTS L164-190 (ramp.sithpFactor L169),
  SAMPLE_FLOW L193-213, flowDerived L322-331, setRigReq/applyRig L356-361, derive L480-580 (sizing L553-565, Cv_psvU L569-571),
  algebraic L581-607 (vacuum breakers L594, L606), xferDP L620-626, inventories L650-652, zeroCum L659, massErr L663-670,
  bpvKc/bpvBias L801-825, limits L836-842, valve helpers L884-924, autoDivert L966-983, raise L1058-1069, LAH_SURGE_BOTH text
  L1127, pumpLatched L1133, surgeHHClose L1151-1159, tripBlock L1161-1176, quiet / quiet lists L1184-1189, surgeBlocked
  L1191-1196, processAlarms L1197 (LSHH_SEP L1213, PSHH_SURGE L1235-1236, LAH_SURGE_BOTH L1265), substep L1329 (routing
  L1418-1520, dump back-pressure L1418, flux limiters L1488-1495), overflow L1538-1548, flare L1560, upstream inflow / WHP / PB
  L1577-1595 (SITHP L1591, PB L1594-1595), chooseH L1657-1697, designAlarms L1776-1801, refresh nodes L1812-1830 (choke J-T
  L1819), segments L1835-1852, rates L1938-1946 (GOR L1943, shrink L1946), rigup copy L1949-1953, snapshot esd.blocking L1970,
  getControls/getRigup L2139-2143, setControls L2144-2164, setValveNow L2180-2195, resetTrip L2214-2237, RIG_TXT/setRigNow
  L2259-2299, blockingNow L2300-2304, _internal L2307, exports L2323-2331, self-tests 13 (L2370-2385), 14 (L2555-2559), 26
  (L2708-2721).
- `32-wts-3d.js`: EQ_IDS / STEP / TAGS / TITLES / PREF_SIDE / ANCHORS L49-60, FIT_PTS L69, PROXIES L77, VALVE_PROXIES L90,
  EQ_BOX L98, VIEWS L103, FOCUS L111, ROUTES L119, PSV_ROUTE L143, TEES L144, BYPASS_SPOOLS L146, RIG_GROUPS L152, SEG_CHIPS L155,
  NULLABLE copy L174, layoutLabels L446, NODE_NAMES / LINE_NAMES L525-526, makeNorm L529, rigSigOf L562, normalize L563-648
  (sampleP/T L577), fakeSnapshot L672, CK-101 block L1585-1607, vessel() L1648, T-201 L1781-1839, LCV-201 L1841-1854, gauge walkway
  handrail L1904-1906, lamps L1920-1928, spools L1992-2003, HALO L2092, BL L2101, ghosts L2170-2190, buildPipes L2300-2363, tracer
  allocation L2404-2410, userMoved L2551, viewTarget L2564, mkChip / STEP text L2601-2613, OBST L2622, updateLabelText L2653,
  occlusion L2806, PHA/PHS L2834, edgeState L2871 (chainEntry[7] L2897), pickPhase L2963, updateVesselParticles L3000,
  updateVessels L3070, updateParts L3205, lsig L3244, pickAt L3426-3436, valveOf L3452, rebuildTier L3683, snapshot L3693,
  rebuild gate L3709, _internals L3894-3919, self-test L3997.
- `38-wts-live.js`: constants L36-76 (STEP L45, FAULTS L57, RIG_FALLBACK L64), liveNodes L189, summaryOf L341, rigItems / readRig /
  writeRig / rigOut L768-792, buildRig L982, renderRig L1002-1027, hookSim L1076, fault toasts L1107, toggleValve L1133, fullRig
  L1171, applyFlow L1212, onAction L1324, updateHud L1662, cardSpec L1868, renderCardActions L2050, autoRow L2109, draw2dLive
  L2360, RIG2D L2532, drawRig2d L2533, drawStrip L2616, valves2d L2682, zones2d L2692, nearValve L2682-2720, renderVin L2729,
  confirmBox L2788, doAct L2957, `_internals` L3271.
- Host `well-testing-app.html`: `#appVersionLabel` L707, RELEASE_NOTES l.11035, WTS_IDS l.126583, calcWTS l.126651-126915,
  wtsClamp use l.126668, WTS_DIAG_LAYOUT l.126912, wtsDrawDiag l.126913, bridge l.127148, simSamples l.96856, report `.rp-skip`
  handling l.2638 / l.2666.
- `tests/_harness.js` header L1-20, PIPELINE L88-100, buildFromSources L130-189; `concat-round7.js` build / stripSelfTest
  (exports L91); `inject-round7.js` (exports L83; anchor Round-6 END); `inject-round8.js` (anchors after Round-7 END).
- `gui-sweep.js` simJob L988-1032 (fault loop L1019-1026); `wts3d-test.js` pins L142-144, L181, L202-211, L298, L304, L315, L473,
  L500-506, L572-573; `perf-budget.js` (bundle × 1.10, startup ratio).

---

## Appendix B — Review notes

The review raised 2 blockers, 18 majors and 24 minors. All blockers and majors are resolved; every minor is resolved, some with a
variation explained below. Section numbers refer to this revision.

### B.1 Blockers
| Issue | What changed |
|---|---|
| §4.2 dry-gas NaN (wc, μL, ρL, Δρ, c_mix, GVF = 0/0) | §4.2: gas carrier when Qo+Qw < 1e−6 (wc 0, Lee-Gonzalez-Eakin μg — a local pure copy in 31, since the engine loads stand-alone — ρg, Δρ = ρs − ρg, f_g 1); the mixture speed of sound adds the liquid term only when (1 − GVF) > 0; q_T ≤ 0 → `desOK = false`, GVF 0, v_in 0, eff 0, ΔP 0, block skipped. §9.2: dry-gas (5 lb/MMscf) and zero-rate finite walks. The host gains `wts_sandGas` (Q30) so the dry-gas case is reachable from the form |
| §10.3 Round 7 not in the harness | WP0 inserts `['concat-round7','inject-round7']` into PIPELINE before round 8 (both modules already export `build` / `inject` like the others; inject-round8 anchors after Round-7 END) and updates the header; harness self-checks (probe VERSION override; `--sources` = `--html` on the unchanged tree); §10.3 states that until WP0 merges the only gate for 31/32/38 is wts3d-test; CLAUDE.md note in §11. The self-check uses a probe VERSION ('9.9.9-probe') rather than '1.4.0', so it is meaningful before WP-E0 bumps the version |

### B.2 Majors
| Issue | What changed |
|---|---|
| §5.5 T-202 alarms when out; XFER2_DRYRUN act | `Q_SURGE2` lists every T-202 id (+ `LAH_SURGE_ALL`); §3.3: on removal, explicit release of the act alarms (`XFER2_DRYRUN`, and `LSHH_SURGE2`, which now also carries an act) then `quiet(Q_SURGE2)`; `blockingNow` / snapshot blocking use `!A.act` (bit-identical today); `raise()` act branches placed before the generic trip branch (§5.5 code); both tests in §9.2 |
| D4 / §4.8 DES_RATING / Q18–Q19 | New input "Max shut-in wellhead pressure (psig)" (`wts_SITHP` → `flow.sim.sithp_psig` → `cfg.desander.sithp_psig`; blank → 1.2 × WHP labelled estimated); gauge-vs-gauge check plus temperature class; `DES_RATING` is an alarm with the requested text; new `DES_PSHH` (PSHH-103) trip, stated as the one exception to Q19; D4 states the flowhead / SDV-101 pressure-class rule. The input lives under `cfg.desander` because it is used only by this check; the build-up curve keeps `sithpFactor` (bit-identity) |
| §4.4 dump interlocks / ESD | Scalar `P_acc`; bleed (τ = bleedS/4) and equalise (τ = equalS/4) gates at 50 psig and 75 psi with analytic event location; bleed timeout → `DES_DUMP_FAIL` 'accumulator not bled' with no release; fault `desanderIsoPassing` (τ 30 s, equilibrium ≈ 0.71·PB); ESD hold phase `held` with resume / abort after the reset (`dumpDesander(cmd)`); `dump.Pacc` in the snapshot; one test per interlock and the hold. Consequence: the bleed lasts 307 s on the sample (3,000 psig needs > 4 τ), so the sequence is 1,043 s, not 1,036 s |
| §4.3–4.4 accumulator / buffer overflow | `min(buf, cap − acc)` on reopen and every abort; g, room and capt clamped; `DES_LAHH` covers "both full"; auto-dump blocked after `DES_DUMP_FAIL`; overflow test with the stuck fault and three dumps |
| D14 / §5.2 inlet split | Check valve per branch; pressure-driven split with conductance sized for the design dump flow at 3 psi; Ph in closed form for one flowing branch, 12-step bisection for two; Ph (one substep lagged) is the dump back-pressure; legacy path untouched while XV-202 is shut; test with PCV-203 stuck closed. Branch heads are zero because the inlets enter the gas space (as the legacy Pd = Pu) |
| §5.3 PSV-202 sizing | `Cv_psvU2` defined in `derive()` from the four cases at 10 % accumulation, no split credit, not reused from `Cv_psvU`; static sizing test plus a dynamic `oilDumpStuckOpen` test (Pu2 ≤ 1.10·mawpU2 whether or not PSHH-202's closure gets there first, since PSHH-202 now removes the source); fire case stated as not modelled |
| §5.5 PSHH-202 / LSHH-202 actions, Q5 | PSHH-202 closes XV-202, holds PCV-204 shut, then ESD; LSHH-202 `act:'xv202'` closes XV-202 without an ESD (excluded from blocking); U5, Q5 updated; PSHH-201 kept as v3.3, listed as a known limitation (§1.2, §11) |
| §5.3 / §5.7 gas accounting | Stated explicitly: `qFlash = qFlash1 + qFlash2`; `gvent2` in `cum.gaugeFlash` and `cum.gaugeVent`; transfer-weighted BoR for shrink (new `cum.xo1/xo2`, legacy formula while `xo2 = 0`); T-202 vacuum-breaker air in `cum.vacBreak`; separator limiter L1493 includes `qBlk2` (0 when out → bit-identical sum); direct tests not through `massErr` |
| §4.7 / §4.9 particle size in erosion | C2 taken out of the coefficient; per-stream `C2p` tables and `C2in`; passed-sand C2 0.110 vs inlet 0.400 (d50s value 0.332); anchors updated. Combined with the throat-velocity minor below, the anchors are 1,594 / 23.6 mpy (ratio ≈ 68×; the review's 392 / 5.8 mpy were for the C2 change alone) |
| §4.8 PDAH on the gas sample | Relative threshold max(2 × expected, expected + 5) when expected ≥ 2 psi, or 75 psi absolute; text gives the ratio; test on SAMPLE_FLOW (plugged 11.8 psi ≥ 8.93 psi) |
| §8.1 / D18 / §8.3 tables not filtered by the rig-up | New §8.0 rule; 32 builds `S.proxies / S.valveProxies / S.obst` in `rebuildTier` from filtered arrays (pickAt, occlusion, labels); VIEWS / FOCUS filtered; optional chips hidden and `.n` rewritten on a rigSig change; tracer weights over built edges with DR keeping the remainder; 38 `valves2d(L, st)` used by `zones2d` and `nearValve`; both-out tests for pickAt, cameras, tracers, phone tap |
| §3.4 / §8.4 renderRig | `renderRig` added to §3.4 with core-only counting and button test, extras text, optional-row texts and titles, `rp-skip` on optional rows that are out; test for the default card and report |
| §8.1 T-202 placement / clearance gate | T-202 drawn at R 1.0 at (12.5, 2.3); clearance test redefined on rendered primitives with a `PROPS` table (EQ_BOX and PROXIES excluded); inscribed proxy; PSV-202 on the −x side of the head with its discharge route `PSV2` to the PSV header; LM2 / BLK2 end on the R 1.0 shell (x 11.55) |
| §7 / §9.2 golden | Golden JSON dropped. `tests/_wts-sim-v33.js` (31 at `666be77`, self-test stripped) runs side by side with the new engine; exact `===` on every v3.3 path; sig rule `slice(0,8)` equal and `slice(8) === '00'` |
| §7 performance gate | `wts-sim-perf.js`: 2 warm-ups, ≥ 10 interleaved A/B pairs against the frozen engine, min and median-of-ratios ≤ 1.05; both-in ratio ≤ 1.6 against the default spread (1.4 planned; raised at WP-I, §7); code-review check of the guards; `perf-budget.js` added to §10.5. The timing assertions live in the tool (a gate at every engine merge and at WP-I) rather than in the accept suite, where each test gets a cold vm |
| §6.11 / §10.1 contract owners | `WTS_sim.stepFor(rig)` exported from 31 with STEP fallbacks in 32/38 and the four combinations pinned; action payloads in the fixture; the 38 foundation moved into WP-E0 (constants, RIG_FALLBACK, rigIn, EQV, persistence, renderRig predicates, stepFor fallback, test hooks); WP-E0 adds the full set of guarded hooks with call sites, so E1 and E2 never edit each other's lines |
| §3.3 / §5.2 T-202 leaving the rig-up; prefs precedence | §3.3 snaps XV-201A/B open (make-before-break, logged) when T-202 was the only route, refuses when T-201 cannot take the dumps; precedence stated (prefs restore on session start; adding from the card snaps XV-202 shut); U4 and tests updated. Snapping is used instead of a timed stroke because a rig-up change is already an instantaneous line-up operation (T-202 entering snaps XV-202 shut) |
| §10.4 / §11 merge order and version | Integration on `sim-equip`, merged to `Dev` only at WP-I; version fixed at WP-I as the next point release after the then-current `RELEASE_NOTES[0].ver`, applied to all five places |

### B.3 Minors
| Issue | What changed / why it differs from the suggestion |
|---|---|
| §4.3 numerical guards | `fI = max(fInst, 1e-3)`, `v_in` floor, x clamped, tables extended to +2 (101 points), isFinite guard. The floor is **0.1 ft/s** (the flowDerived minor's value) rather than 0.05, and the x clamp is **[−3, +2]** (the extended table) rather than [−3, +1]: the two minors proposed different values and one had to be chosen |
| §4.3 / D6 flow-back profile | `Wfb·min(1.5, fI)^rateExp`; own PSD (400 µm, σg 1.5) with its own E and C2 tables, capture weighted by mass. Note: with the coarser PSD the time to LAH is **3.50 h**, not 3.78 h (the 3.78 h anchor assumed the formation PSD); U2 and §4.9 updated |
| §4.6 coupling | Local copies only; critical gas law only for `Critical && Qg > 0`, √ΔP law otherwise; C1-smooth minimum and 1 % hysteresis; scope sentence added. Both laws are written on `X.PD` against steady values rather than on the instantaneous PB, so the coupling responds to the desander only (no loop through PB noise or the fInst ramp) |
| §6.4 esd node spike | Instead of filtering PD and using `PB + X.PD` (which still shows a continuous bump of about ΔP/e), the legacy PB law integrates `X.PBu` (upstream of the desander = ESD node) and `X.PB = X.PBu − X.PD` with `X.PD` lagged 5 s. The ESD node is then untouched by any PD step and the choke inlet moves smoothly; test asserts < 0.1 psi deviation on a bypass toggle |
| §4.8 hydrate / bleed / temperature | Desander node warm-up τ = 3 × warmTau; `HYD_dsAcc` at Tamb and P_acc; `HYD_dsBleed` at bleed start with the stated estimate (65 °F on the sample: no warning; a 120 °F well: warning); outlet T minus the desander J-T drop |
| §1.2 / §4.3 sand carry-over | `cum.sandToSep` / `cum.sandToFlare`; separator card row; `SAND_SEP` warning; balance extended; LCV erosion and plugging stated as not modelled |
| §4.5 bypass line-up and faults | Bypass defined as a line-up (HV-104 open, blocks shut, logged); `desanderBypassPassing` fault (10 %, capture × 0.9, ΔP × 0.81, PDAL on the reduced ΔP); card note on staying pressurised |
| §4.7 bands and impact velocity | Bands in mil/d (projected loss per 24 h), mpy secondary; gas part of Up at the throat pressure, capped by the mixture sound speed there. The band limits are **2.08 / 20.8 mil/d** (5 % / 50 % of a 125 mil allowance over 72 h, configurable) instead of the suggested 5 / 50: with 5 / 50 the 10 pptb "DS-101 out" anchor (4.36 mil/d) would read OK and the indicator would not show the desander's effect in the steady case |
| §3.3 / §5.2 removing T-202 as the only route | Covered by the major above (snap open / refuse); both cases tested |
| §5.2 auto route vs LAH_SURGE_BOTH | Suppressed while the auto route has room; new `LAH_SURGE_ALL` when T-202 is also at or above sp |
| §4.8 alarm gating, §9.2 anchors | `quiet(Q_SAND)` on the sandOn true → false transition in `setConfig` / `setFault`; `DES_RATE` warning (after startupGrace, so not at every start-up); helper test inputs stated (`dp(14.17, 20.7)` = 3.93 psi; `dp(55, 30)` = 32.1 psi) |
| §8.3 noSurge refactor | Dropped (no alias kept); 3D / 2D "both out" rule changes removed; wts-rigup row rewritten; the WP-L ↔ WP-2D dependency is gone |
| §6.3 / §4.3 finite inputs | Host `wtsClamp` with the §6.3 ranges for all seven inputs; engine `flowDerived` isFin + clamp, and `derive()` clamps cfg values (covers setConfig); `v_in` floor and x clamp as above; not-flowing values defined |
| §8.2 2D label collisions | Segment-1 phase label at ≈ 237; 'Liquid' at ≈ 907; shortened seg-0 spec label; LCV-201 zone (lcvX2−12, by+16, 24×24); LCV-202 / XV-202 zones — all inside the new-item variants only |
| D1 / U6 default-view claim | Chosen: two fixed variants per row (the v3.3 row while its item is out), so the claim holds for the 2D too; D1 lists what every user still sees change (inputs, Scenarios entries, Rig-up switches) and the release note says it |
| §8.1 chip crowding | DS PREF_SIDE 'se'; wts3d-test label-layout check at 1380 × 700 with both in |
| §8.1 tracers X0 → X2 | `nextS[X0]` = X2's arc length to the elbow (like `sDRBjoin`); VENT2 likewise if VENT carries tracers; BLK2 and PSV2 leave a route part-way and are own chains |
| §5.1 / §3.4 ES5 style | `isNum(…) ? … : PspU`; ES5 rule in the conventions and §10.3 |
| §9.3 GUI sweep job | Reload (or reset and clear faults) before the equipment run; ×600 for ≥ 3 s; assert a completed dump; expectation "no new error / warning findings", cosmetic imperial labels accepted |
| §8.3 Scenarios menu | Labels: local first, engine fallback, eight new local labels. **Order differs from the suggestion**: the v3.3 entries keep their v3.3 order and the new engine ids follow in engine order, because taking the order from `WTS_sim.FAULTS` would reorder the menu for every user (the concern the issue itself raised) |
| §11 release items | `#appVersionLabel` fallback, `perf-budget.js`, CLAUDE.md harness note and stats, wts3d-test L572-573 pin (→ 10) added |
| §4.2 naming | "Wood" removed; the formula is written as the homogeneous-mixture speed of sound `1/(ρm·c²) = Σ αi/(ρi·ci²)`; §10.3 adds "no eponym for the mixture speed of sound" |
| §9.2 view tests before the engine | Recording stub sim through `WTS_live._internals.useSim` (added in the WP-E0 38 foundation, since `_internals` has no setter today) plus `fakeEquipSnapshot`; engine-backed versions at WP-I |
| §8.1 framing with items in | `fitPts(rig)`; a rig-up change refits only when `userMoved` is false; framing gate for all four combinations at 1380 × 700 and 375 × 812 with the HUD heights measured after the `tDs` line |

### B.4 Additions not requested by the review
- `wts_sandGas` host input (Q30) — needed for the dry-gas case the blocker describes to be reachable from the form.
- `rigSigOf` (32 L562) applies the optional rule to the new groups; today it treats a missing key as in, which would make the
  default 3D sig `'11111111'`.
- `surge2.share`, `surge2.Ph`, `surge2.blanket.held`, `surge2.psv.Cv`, `desander.carrier`, `desander.rate`, `dump.failMsg`,
  `auto.blocked` in the snapshot, so the views can show the new behaviours without engine internals.
