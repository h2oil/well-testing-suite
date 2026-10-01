# H2Oil Well Testing Suite

Engineering calculators, a live well-test simulator, pressure- and rate-transient analysis (PRiSM)
and live Modbus data for surface well-testing engineers. The web app is one self-contained HTML
file (`well-testing-app.html`) that runs in the browser and works offline. The same file is
packaged as a free iOS app, **H2Oil Well Testing**.

- **Web app:** <https://pb-handbook.com>, or open `well-testing-app.html` from this repository
- **iOS app:** free, with no in-app purchases, no account and no analytics (see [ios-app/README.md](ios-app/README.md))
- **Current release:** v3.1 (2026-10-01)
- **Contact:** software@h2oil.co.uk

---

## Contents

- [Highlights](#highlights)
- [Feature catalogue](#feature-catalogue)
- [PRiSM: well test analysis](#prism-well-test-analysis)
- [Live data: Mini WellOS, Modbus and the historian](#live-data-mini-wellos-modbus-and-the-historian)
- [Units, standard conditions and standards](#units-standard-conditions-and-standards)
- [Reports, projects and multi-well](#reports-projects-and-multi-well)
- [Getting started](#getting-started)
- [Privacy](#privacy)
- [For developers](#for-developers)
- [Release history](#release-history)
- [Licence and contact](#licence-and-contact)

---

## Highlights

- **55 calculators and tools** in 9 sidebar groups: metering, chokes, flowlines, test-system safety,
  well kill, separators, flare radiation and emissions, PVT, IPR and deliverability, process
  equipment, electrical and field conversions.
- **Well Test Simulator:** a live process model of the test spread (wellhead → ESD valve → choke →
  heater → separator → surge tank → gauge tank, with gas to flare), in 3D or as a 2D schematic.
- **PRiSM:** pressure-transient and decline/rate-transient analysis with 45 models,
  Levenberg–Marquardt regression, auto-match, deconvolution, gas m(p), and a report.
- **Mini WellOS:** a live SCADA view driven by Modbus TCP/RTU or by the simulator, with alarms,
  trends and an in-browser SQLite historian.
- **Imperial ⇄ metric** on every page, and a standard-conditions selector for gas volumes.
- **Reports:** PDF and PNG export of any page, a one-click Quick Report of the whole job (Daily and
  Final templates), CSV/JSON export, and `.h2oilproj` project files that hold several wells.
- **Offline and private:** every calculation runs on your device. There is no server, no account and
  no upload of well data.

---

## Feature catalogue

Every page below is in the app's sidebar, in the same groups and order. Pages marked *(plug-in)*
are self-registering files in `prism-build/4N-calc-*.js` / `6N-*.js`. The other pages are in the
host route table (`const pages = {…}` in `well-testing-app.html`).

### Overview

| Page | What it does |
|---|---|
| Dashboard | Search, ☆ favourites, recently used, and one tile per calculator grouped as in the sidebar |
| Client & Well Info | Client, well and job details (and an optional logo) printed on every report |
| Well Comparison | Side-by-side comparison of the wells in a multi-well project |
| Release Notes | Change log of every release |
| Privacy | How data is handled in this build (web or iOS) |

### Well Testing

| Page | What it does |
|---|---|
| AGA-3 Gas Metering | Orifice-meter gas rate per AGA Report No. 3 / API MPMS 14.3 (Reader-Harris/Gallagher Cd, expansion factor, Fpv = √(Zb/Zf)) |
| Dual Choke | Intermediate pressure between two chokes, equivalent bean, critical-flow check, Gilbert multiphase |
| Choke Flow Rates | Gas rate through a fixed choke (Thornhill–Craver), oil rate by Gilbert and Ros |
| Choke Conversions | Choke sizes in 64ths, decimal inches and millimetres |
| Bottoms Up Time | Circulation time for returns from rate and string volume |
| MCF & Shrinkage % | Meter correction factor and shrinkage from turbine-meter and surge-tank readings |
| Casing & Tubing | Casing and tubing capacities, annular volume and totals from a shared API 5CT tubular table |
| Well Test Simulator | Live 3D / 2D process model of the test spread with alarms, ESD, divert valves, fault scenarios and erosional-velocity (API RP 14E), J-T and hydrate checks |
| Orifice Plate Selection *(plug-in)* | Inverse AGA-3: the bore that keeps DP between 20 % and 80 % of the transmitter range, with plate-change rates |
| Choke Performance *(plug-in)* | Critical pressure ratio, gas rate through a bean, Gilbert / Ros / Baxendell / Achong beans, rate vs WHP and bean-up planning |
| Flowline Pressure Drop *(plug-in)* | Beggs & Brill with Payne corrections: flow pattern, holdup and Δp per segment from wellhead to separator and flare |
| Line Heat Loss *(plug-in)* | Arrival temperature through bare, insulated or buried lines, J-T cooling at chokes and a hydrate check |
| Meter Proving & NSV *(plug-in)* | Meter factor from prover runs (MPMS 4.8 repeatability), CTL/CPL (MPMS 11.1), S&W and net standard volume (MPMS 12.2) |
| Sampling & GOR QC *(plug-in)* | Separator vs stock-tank GOR, gas rate at laboratory gravity and Z, recombination GOR and bottle checks (API RP 44) |

### Test System Safety

| Page | What it does |
|---|---|
| ESD Hi-Pilot | PSH set point that trips the ESD before a blocked section reaches its relief setting within the ESD response time |
| ESD Lo-Pilot | PSL set point that trips on a target detectable leak rate, with section temperature and a trip check |
| Hydrate Management | Hydrate-formation temperature per segment and Hammerschmidt methanol / MEG / DEG / TEG injection rates |
| Liquid Line / RO | LCV gas blow-by to the atmospheric tank and restriction-orifice sizing |
| Pipe Service Life | Sand-erosion rate (DNV-RP-O501; Salama selectable), remaining life, time to failure and MAWP per segment |
| H2S Exposure & Scavenger *(plug-in)* | 100 / 500 ppm radius of exposure, SO2 from flaring sour gas and scavenger dosing |
| Well Kill & Bullhead *(plug-in)* | Kill-weight fluid, bullhead volumes and strokes, fracture-limited surface pressure, U-tube check, brine guide and gradients |
| Cement & Brines *(plug-in)* | Neat-slurry water, yield, sacks and volumes; two-brine blending with crystallisation cautions |

### Production & Reservoir

| Page | What it does |
|---|---|
| Oil & Gas Rate | Oil rate with VCF, BS&W, meter factor and shrinkage; orifice gas rate; GOR and CGR |
| Solution GOR | Standing and Vasquez–Beggs solution gas-oil ratio |
| PRiSM — Well Test Analysis | Pressure-transient, decline and rate-transient analysis (see [PRiSM](#prism-well-test-analysis)) |
| Gas Deliverability & AOF *(plug-in)* | Back-pressure (C, n) and LIT analysis of flow-after-flow, isochronal, modified isochronal and single-point tests |
| Oil Well IPR *(plug-in)* | Straight-line PI, Vogel / composite with Standing flow efficiency, Fetkovich, future IPR |
| Gas Lift Design *(plug-in)* | Injection-gas gradient, point of injection, gas requirement, unloading-valve spacing and valve schedule (API RP 11V6) |

### Separation & Vessels

| Page | What it does |
|---|---|
| Separator Retention | Retention time from capacity, level and rate |
| Separator Rating | Souders–Brown gas capacity and liquid retention check |
| Separator Handling | Full handling check: gas capacity with mist-eliminator credit, retention, oil/water split, outlet velocities against API RP 14E and user limits, required Cv |

### Safety & Process

| Page | What it does |
|---|---|
| Flare Simulation | Thermal radiation (API 521) and noise (ISO 9613-2 absorption) with wind tilt, in 2D and 3D |
| PRV / Relief Sizing | API 520 Part I orifice area for gas/vapour, steam and liquid; API 526 orifice selection |
| Vessel & Pipe | Minimum wall thickness for shells and 2:1 elliptical heads (ASME VIII-1) |
| Flame Arrestor | Flame arrestor NPS from flow capacity and allowable pressure drop |
| ARC Valve Sizing | Automatic recirculation valve sizing for pump minimum flow |
| Flare Emissions *(plug-in)* | Flared volume, heat released, CO2 / CH4 / N2O / CO2e (IPCC AR4/AR5/AR6 GWPs), SO2 and liquid-burner CO2 |
| SO2 / H2S Dispersion *(plug-in)* | Gaussian-plume screening with plume rise: ground-level ppm vs distance against IDLH, STEL and TWA |

### Process Equipment

| Page | What it does |
|---|---|
| Pipe Sizing | Velocity and Darcy–Weisbach pressure drop, erosional limit and a sand quick check |
| Pump Sizing | TDH, NPSH, power and pump type |
| Turbine Meter | Liquid turbine-meter sizing with Reynolds number and cavitation checks (API MPMS 5.3) |
| Indirect Heater | Water-bath heater duty, fuel use and heater category |
| Air Compressor | Compressor type and receiver sizing for instrument and utility air |

### Electrical

| Page | What it does |
|---|---|
| Generator Sizing | kVA from running loads and worst-case motor starting |
| Cable Sizing | Copper cable by derated ampacity and voltage drop |
| Voltage Drop | Voltage-drop check for copper or aluminium cable |
| Electrical & Pumps | Three-phase motor current, kW/HP and mud-pump output |

### Fluid & Field Calcs

| Page | What it does |
|---|---|
| Gas Calculations | Gas velocity, volume, gradient and downhole pressure (with "use calculated Z" from Gas PVT) |
| Fluid Properties | API gravity at 60 °F, bubble point and shrinkage |
| Tank Calculator | Rectangular, vertical and horizontal cylindrical tanks: volumes, levels, strapping factor and rates |
| Chemical & Dosage | Chemical injection rate and chloride titration |
| Unit Conversions | Ten categories of oilfield unit conversion |
| Analog Signal | 4–20 mA and 0–10 V ⇄ process value, with fault bands |
| Gas PVT *(plug-in)* | Pseudo-criticals with Wichert–Aziz sour correction, Z (DAK, Hall–Yarborough), Bg, density, viscosity, cg, speed of sound |
| Scale & Water Analysis *(plug-in)* | Charge balance, ionic strength, Langelier and Stiff–Davis indices, Oddo–Tomson SI for calcite, barite, celestite, gypsum, anhydrite |

### Mini WellOS and Live Data

| Page | What it does |
|---|---|
| Historian *(plug-in)* | Records Modbus, form and simulator data in an in-browser SQLite database; trends, tables, CSV / Excel export, backup and restore |
| Mini WellOS *(plug-in)* | Live SCADA view of the spread: 3D and 2D P&ID, KPI tiles, trends, alarms, events, CSV logging, Send to PRiSM |
| Modbus Config *(plug-in)* | Modbus devices and tags, scaling, alarm limits, links to well-test variables, simulator, bridge setup guide |

Most calculators also pick up their starting conditions from the Well Test Simulator once it has
been run, and several pages link to each other (for example "Use AOF from Gas Deliverability" on
the H2S page, and "Send to PRiSM rate history" from Oil & Gas Rate and AGA-3).

---

## PRiSM: well test analysis

PRiSM (Production & Reservoir → PRiSM — Well Test Analysis) is a pressure-transient, decline and
rate-transient workshop that works in field units.

- **Workflow:** five steps (① Data → ② Flow periods → ③ Diagnose → ④ Model & fit → ⑤ Report), a
  one-click **▶ Analyse**, undo/redo, and a Tools drawer for the advanced panels.
- **Data:** CSV, TSV, DAT, ASC and Excel/ODS import with column auto-mapping, outlier filters,
  decimation and interactive crop; multi-rate history with superposition; flow periods detected
  and selectable.
- **Diagnostics:** Bourdet log-log derivative (sign-aware Δp for drawdowns and build-ups),
  MDH / Horner / superposition semilog, square-root and quarter-root time, spherical and
  sandface convolution, and 24 click-on-plot line tools.
- **45 models** (41 transient + 4 decline): homogeneous; infinite- and finite-conductivity
  fractures; inclined, horizontal and partially penetrating wells; double porosity; fault,
  channel, rectangle and intersecting-fault boundaries; radial and linear composite; multi-layer
  with and without cross-flow; multi-lateral; interference and pulse tests; user-defined curves;
  Arps, Duong, SEPD and Fetkovich decline. Each has a schematic and a plain-language description.
- **Regression:** Levenberg–Marquardt with parameter freezing, 95 % confidence intervals, R², RMSE,
  AIC and bootstrap. A fit that stops early or sits at a parameter limit is not adopted.
- **Auto-match:** classifies flow regimes, fits the candidate models and ranks the top three by
  ΔAIC, preferring the simplest when candidates are equivalent; the result is explained in plain
  English.
- **Straight lines and skin:** m, k, p1hr, p*, skin, Δp skin, flow efficiency, damage ratio,
  productivity index, skin decomposition and rate-dependent skin.
- **Gas:** m(p) end to end, normalised pseudo-time, skin-vs-rate (S′ = S + D·q), gas p1hr / p* /
  Δp skin in psi, and AOF/IPR from the test's flow periods.
- **Advanced:** deconvolution with total-variation regularisation and L-curve selection; 17 PVT
  correlations; tide analysis (10 constituents) with a compressibility estimate; synthetic PLT and
  rate-from-pressure; type-curve match by dragging.
- **Decline and RTA:** EUR to an abandonment rate, P10/P50/P90, flowing material balance and √t
  linear-flow plots.
- **Workspace:** save named fits, compare them on the plots and in a table, named analysis branches,
  and a model browser with search.
- **Field tools:** gauge register with a resolution check, sequence-of-events log with plot markers,
  and a total-compressibility builder.
- **Report:** results with confidence intervals, interpretation, plots, model comparison and an
  input appendix that flags defaulted values; PDF and CSV, and included in the Quick Report.

Known limitations are listed in [CLAUDE.md](CLAUDE.md#known-limitations-verified-not-yet-fixed)
(for example, decline type-curve matching for k, S and re is not implemented, and horizontal-well
fits are slow).

---

## Live data: Mini WellOS, Modbus and the historian

**Mini WellOS** shows the test spread as a live SCADA screen: a 3D view and a 2D P&ID, KPI tiles,
live values with data quality, trends, alarms with acknowledge, an event log, CSV logging and
**Send to PRiSM**. A switch chooses between form data (the simulator model) and live Modbus tags.

**Modbus Config** sets up devices and tags: polling rate, data type, byte/word order, scaling,
units, alarm limits and links to well-test variables, with JSON/CSV import and export. Transports:

| Transport | Where | Notes |
|---|---|---|
| Modbus TCP through the bridge | Web browsers | Browsers cannot open TCP sockets, so a small local bridge relays WebSocket ⇄ Modbus TCP |
| Modbus TCP (native) | iOS app | Direct TCP on the local network; iOS asks for Local Network permission once |
| Modbus RTU (Web Serial) | Chrome / Edge | RS-485 adapters through the Web Serial API |
| Built-in simulator | Everywhere | A virtual slave for trying the pages without hardware ("Load simulator demo") |

The app only reads by default. Writing to equipment needs **Enable writes** on the Modbus page,
a confirmation for each write, and a bridge started with writes allowed.

The **Historian** records Modbus, form and simulator data in SQLite in the browser (OPFS, or sql.js
in IndexedDB, or IndexedDB). It has a multi-axis trend viewer, a time-aligned table, retention and
1-minute downsampling, CSV/Excel export and `.sqlite` / `.json` backup and restore.

### Setting up the Modbus bridge (web version)

The bridge is `tools/modbus-bridge/modbus-bridge.js`: one file, no dependencies, Node.js 18 or
newer. The iOS app does not need it.

- **Windows (easiest):** download and run
  [WTS-Modbus-Bridge-Setup.exe](https://github.com/h2oil/well-testing-suite/releases/latest/download/WTS-Modbus-Bridge-Setup.exe)
  from the latest release.
- **macOS / Linux:** one line in a Terminal:

  ```bash
  curl -fsSL https://github.com/h2oil/well-testing-suite/releases/latest/download/wts-modbus-bridge-install.sh | bash -s -- --autostart --yes
  ```

- **From the app:** Modbus Config → *Connecting to real equipment* downloads the bridge package
  (bundled in the app, so it works offline), generates an installer pre-filled with your devices,
  and has a **Check bridge** button.
- **By hand, from this repository:**

  ```bash
  node tools/modbus-bridge/modbus-bridge.js
  ```

Then add a device with transport "Modbus TCP via WebSocket bridge", the device IP, port and unit
id, and bridge URL `ws://127.0.0.1:8502`.

Security defaults (bridge v1.2.1):

- **Listens on this PC only** (`127.0.0.1`). Other machines cannot use it unless you set `--listen`.
- **Any device IP is allowed by default.** List `--allow <ip>:<port>` targets to restrict it.
  Running an installer again switches a device list written by an older installer to any device
  (`--keep-allow` keeps it).
- **Read-only unless enabled:** write requests (function codes 05, 06, 15, 16) are refused unless the
  bridge is started with `--allow-writes`.
- Accepts pages only from `localhost` / `127.0.0.1`, `https://pb-handbook.com` and the iOS app.
  Saved `file://` copies of the app (Origin `null`) are refused unless you opt in with
  `--origin null`.

Installer options, the configuration file, the health check, autostart, uninstall and
troubleshooting are in [tools/modbus-bridge/README.md](tools/modbus-bridge/README.md).
`tools/modbus-bridge/fake-slave.js` is a small Modbus TCP slave for testing without hardware.

---

## Units, standard conditions and standards

- **Imperial ⇄ metric:** a Units switch in the header changes every page between oilfield units
  (psi, °F, ft, bbl, MSCF/D, BPD) and metric (kPa, °C, m, m³, 10³ m³/d, sm³/sm³). Calculations run
  in field units, and conversion happens at the inputs and results, so both systems give the same
  answer.
- **Standard conditions:** a Std selector next to Units: calculator default, 60 °F at
  14.696 / 14.65 / 14.73 psia, 15 °C at 101.325 kPa, or 0 °C at 101.325 kPa (normal). The
  gas-volume calculators state the basis they used.
- **Decimal comma:** an optional input mode for locales that use a comma.

Standards and methods cited in the calculators:

| Area | References |
|---|---|
| Gas metering | AGA Report No. 3 / API MPMS 14.3 (Reader-Harris/Gallagher), ISO 5167 |
| Liquid metering and proving | API MPMS 4.8, 5.3, 11.1 (CTL/CPL), 12.2 (net standard volume); API RP 44 (sampling) |
| Relief and flare | API 520 Part I, API 526, API 521; ISO 9613-2 (noise absorption) |
| Erosion and piping | API RP 14E (erosional velocity), DNV-RP-O501 (sand erosion), ASME B31.3 (MAWP), ASME B36.10 (pipe schedules) |
| Vessels | ASME VIII-1 (shells and 2:1 heads); Souders–Brown and GPSA Engineering Data Book for separators |
| Safety systems | API RP 14C (ESD pilot settings) |
| Tubulars | API 5CT / API TR 5C3 (casing and tubing), API 5DP (drill pipe) |
| Artificial lift | API RP 11V6 (gas lift design) |
| Emissions | IPCC AR4 / AR5 / AR6 GWP-100, 40 CFR 98 |
| Electrical | IEC 60364-5-52, BS 7671 (cable ratings) |
| Water chemistry | ASTM D3739 (Langelier), ASTM D4582 (Stiff–Davis), Oddo–Tomson |
| Correlations | Standing, Vasquez–Beggs, Beggs–Robinson, Dranchuk–Abou-Kassem, Hall–Yarborough, Lee–Gonzalez–Eakin, Sutton, Wichert–Aziz, Hammerschmidt, Beggs & Brill with Payne, Gilbert / Ros / Baxendell / Achong, Thornhill–Craver, Vogel, Fetkovich, Arps, Duong, Bourdet, Stehfest |

---

## Reports, projects and multi-well

- **PDF / PNG** export of any page, with Client & Well Info, numbered inputs and results, tables,
  charts, schematics and the 3D view.
- **Quick Report:** one job report that combines every calculator you used, with Daily and Final
  well-test templates or your own.
- **Copy results** on every calculator, and CSV / JSON export of any page.
- **Autosave:** every input saves as you type and is restored when you come back.
- **Project files** (`.h2oilproj`) hold every input on every page; PRiSM datasets can also be saved
  as `.prism` files.
- **Multi-well projects:** each well has its own inputs, results, simulator settings and PRiSM
  analysis. The header has a well switcher, you can copy inputs between wells, and **Share snapshot**
  writes a read-only HTML copy of a page, a report or the comparison.
- **Help and accessibility:** ⓘ help on key inputs, full keyboard navigation, labelled inputs and
  chart text summaries.

---

## Getting started

### Web

Open `well-testing-app.html` in a current version of Chrome, Edge, Firefox or Safari. Nothing needs
to be installed or built.

To serve it locally (needed for the offline service worker and recommended for the Modbus bridge,
which refuses `file://` pages by default):

```bash
npx http-server -p 8080
# then open http://localhost:8080/well-testing-app.html
```

Or use the hosted copy at <https://pb-handbook.com>.

**Offline use:** when served over http(s), a service worker (`sw.js`) caches the app, so it opens
without a connection and offers a reload when a new version is available. A few optional features
download a pinned library from a public CDN the first time they are used (three.js for the 3D
views, SheetJS for Excel import/export, SQLite WASM / sql.js for the historian); these are cached
too and checked against a SHA-384 hash before use (SheetJS excepted). Everything else,
including all calculations, works with no network.

### iOS

The iOS app (**H2Oil Well Testing**, iOS 15.1 or newer) is free and fully unlocked. It is the same
HTML wrapped with Capacitor 8, with native share sheet, Save to Files, haptics, offline PDF, the 3D
engine bundled, and a native Modbus TCP plugin. Build and release notes (Xcode, Swift Package
Manager, Xcode Cloud) are in [ios-app/README.md](ios-app/README.md).

---

## Privacy

- All calculations run on your device. There are no accounts and no H2Oil server that receives
  inputs, results or files.
- Inputs and results are stored in the browser's local storage (or the iOS app's own storage);
  exports and project files are created only when you save them.
- **Web version only:** anonymous Google Analytics 4 usage counts (page views, fixed button and
  model names, a few UI counters). An allow-list filter drops everything else before sending: no
  input values, no client or well names, no results, no file contents and no typed text. Blocking
  analytics does not affect any feature.
- **iOS app:** the analytics code is stripped at build time, so the app sends nothing.
- **Modbus:** connects only to devices you configure; tag data and history stay in the local
  historian.

The in-app **Privacy** page has the full text and lists the open-source components (three.js,
jsPDF, html2canvas, SheetJS Community Edition, SQLite WASM, sql.js).

---

## For developers

### Repository layout

```
well-testing-app.html     Single source of truth for the web app (~76k lines)
sw.js                     Offline service worker (web only)
prism-build/              Module sources, build scripts and tests
  01-21                   PRiSM core: engine, models, plots, regression, auto-match, PVT, deconvolution …
  22-30, 50               Units layer, Test System Safety pages, help, project save, multi-well, Quick Report, a11y
  31-32, 38               Well Test Simulator and 3D view
  33-37, 39, 51-52        PRiSM workflow, semilog/skin, RTA/DCA, report, field tools, workspace, gas
  4N-calc-*.js            Plug-in calculators (auto-discovered)
  6N-*.js                 Live data: Modbus core/station/page, Mini WellOS, bridge pack and setup
  concat-*.js, inject-*.js  Build pipeline;  combined-*.js are generated
  smoke-test.js, accept-test.js, wts3d-test.js, tests/
tools/modbus-bridge/      Modbus TCP bridge and its installers
ios-app/                  Capacitor 8 iOS wrapper (www/ is generated from the root HTML)
docs/ROADMAP.md           Roadmap and open engineering decisions
wiki/                     Older per-module user notes (written before v1.3; partly out of date)
CLAUDE.md                 Architecture, conventions, build pipeline and shared contracts
PROJECT-NOTES.md          Running change log
```

### Build pipeline

The module sources in `prism-build/` are concatenated in numbered "rounds" and spliced into
`well-testing-app.html` between sentinel comments. Each round has a concat and an inject script:

| Round | Files | Scripts |
|---|---|---|
| Phase 1+2 | 01, 03, 02 | `concat-phase1-2.js`, `inject-phase1-2.js` |
| Phase 3+4 | 04-07 | `concat-phase3-4.js`, `inject-phase3-4.js` |
| Round 2 | 08-15 | `concat-round2.js`, `inject-round2.js` |
| Round 3 | 16-21 | `concat-round3.js`, `inject-round3.js` |
| Round 4 | 22 (units) | `concat-round4.js`, `inject-round4.js` |
| Round 5 | 23-27 (Test System Safety) | `concat-round5.js`, `inject-round5.js` |
| Round 6 | 28, 29 (project save, multi-well), 30, 50 | `concat-round6.js`, `inject-round6.js` |
| Round 7 | 31, 32, 38 (Well Test Simulator) | `concat-round7.js`, `inject-round7.js` |
| Round 8 | 33-37, 39, 51, 52 (PRiSM) | `concat-round8.js`, `inject-round8.js` |
| Round 9 | every `4N-calc-*.js` | `concat-round9.js`, `inject-round9.js` |
| Round 10 | every `6N-*.js` (runs `pack-modbus-bridge.js` first) | `concat-round10.js`, `inject-round10.js` |

After editing a source file, rebuild its round, then regenerate the iOS copy:

```bash
node prism-build/concat-round9.js && node prism-build/inject-round9.js   # example: a calculator
node ios-app/scripts/sync-from-main.js                                    # regenerates ios-app/www/index.html
```

The full rebuild sequence and its checks are in [CLAUDE.md](CLAUDE.md#build-pipeline--do-not-miss-a-step).

### Tests

```bash
# Extract the main script once (smoke-test.js reads prism-build/.tmp/wts-main.js, which is gitignored)
mkdir -p prism-build/.tmp
node -e "const fs=require('fs');const h=fs.readFileSync('well-testing-app.html','utf8');const m=h.match(/<script>\s*\/\* ═+\s*WELL TESTING SUITE([\s\S]+?)<\/script>/);fs.writeFileSync('prism-build/.tmp/wts-main.js','/* ═══ WELL TESTING SUITE'+m[1])"
node --check prism-build/.tmp/wts-main.js

node prism-build/smoke-test.js                          # 311 checks: namespaces, contracts, no running timers
node prism-build/accept-test.js --html --integration    # 776 numeric acceptance tests against the built HTML
node prism-build/wts3d-test.js                          # 97 Well Test Simulator / 3D checks
```

`accept-test.js` builds from the sources by default (`--sources`); `--html` tests the built file.
It also takes `--grep`, `--file`, `--wp` and `--verbose`. The tests run headless in Node (22
recommended) with a small DOM, a recording canvas and virtual timers (`prism-build/tests/_harness.js`).
On a Linux/macOS (LF) checkout, three `wts3d-test.js` checks that expect Windows CRLF line endings
or Windows timing fail; that is expected.

### Adding a calculator

A new calculator is one file, `prism-build/4N-calc-<key>.js`, that registers itself in
`window.WTS_calcRegistry` with a `key`, `title`, `sub`, `group` (the sidebar group), `icon` and a
`render(body)` function. The host adds the sidebar button, dashboard tile, autosave, PDF/PNG export
and Quick Report capture; no host edits are needed. Test it with
`loadApp({ fromSources: true })` in `prism-build/tests/`, then ship with `concat-round9.js` +
`inject-round9.js`. The full contract is in [CLAUDE.md → Adding a calculator](CLAUDE.md#adding-a-calculator-plug-in-registry-round-9).

### Conventions and line endings

- No runtime dependencies beyond the optional, lazily loaded libraries above; engineering code is
  plain JavaScript and `Math.*`, in field units (hours, psi, STB/d, MSCF/d).
- Git stores `well-testing-app.html` and `ios-app/www/index.html` with **LF** line endings; the
  Windows working copy uses CRLF and the inject scripts detect which one is in use. On Linux/macOS,
  write LF. Do not run `sed -i` on the HTML; edit it with an editor or a small Node script.
- `.gitattributes` keeps `*.sh` files LF on every platform (the bridge installer must run in bash).
- `ios-app/www/index.html` is generated: the `ios-sync.yml` GitHub Action regenerates it on pushes to
  `master` / `dev`, and Xcode Cloud regenerates it again before each archive.

---

## Release history

| Version | Date | Highlights |
|---|---|---|
| v3.1 | 2026-10-01 | Module-by-module review of every page and button; metric mode across more calculators and the simulator; simulator rig-up switches and pump-free surge→gauge transfer (sim ~40 % faster); PRiSM undersaturated-oil PVT and crop persistence; Modbus bad-value and timeout handling; ESD Hi-Pilot relief advice per ASME VIII |
| v3.0.2 | 2026-09-30 | Modbus bridge allows any device by default; one-click Windows installer (WTS-Modbus-Bridge-Setup.exe, auto-start at login) and one-line macOS/Linux install; version label follows the release |
| v3.0.1 | 2026-09-30 | Modbus bridge installers for Windows, macOS and Linux; bridge setup guide and Check bridge on Modbus Config; bridge security (null origin refused, DNS-rebinding protection); well-menu fix |
| v3.0 | 2026-09-30 | Mini WellOS, Modbus TCP/RTU and the historian; multi-well projects, Well Comparison and Share snapshot; PRiSM fit workspace and gas m(p); Gas Lift Quick Design; standards review of metering, erosion (DNV-RP-O501), ESD and simulator safety logic; dashboard search and favourites; accessibility and decimal comma |
| v1.8 | 2026-09-29 | Thirteen new calculators (orifice selection, gas PVT, well kill, choke performance, sampling QC, meter proving, flowline, line heat loss, dispersion, scale, cement and brines, PRiSM field tools); simulator divert valves; standard-conditions selector; report templates; offline web app |
| v1.7 | 2026-09-29 | Gas deliverability, oil IPR, flare emissions and H2S exposure; accuracy audit of every host calculator against hand calculations, with fixes |
| v1.6 | 2026-09-29 | Live 3D Well Test Simulator with separator, surge tank and gauge tank process model, alarms, ESD and fault scenarios |
| v1.5 | 2026-09-29 | PRiSM end to end in field units: five-step workflow, results with confidence intervals, straight lines and skin, regression and auto-match, report |
| v1.4 | 2026-09-29 | Redesigned PDF/PNG reports, Quick Report job report, project files for every page, autosave, metric fixes |
| v1.3.x | 2026-04 to 06 | PRiSM (45 models), Imperial ⇄ metric, Test System Safety group, Separator Handling, input help, formula audit |
| v1.3 | 2026-04-23 | Flare 3D/2D improvements; iOS on Capacitor 8 with automated cloud builds |
| v1.0 | 2026-04-16 | Well Test Simulator and the iOS app |
| Launch | 2026-04-06 | Initial release: metering, chokes, flare, relief sizing, decline and pressure-transient quick looks, and the field calculators |

Full notes for every release are on the in-app **Release Notes** page (the `RELEASE_NOTES` array in
`well-testing-app.html`).

---

## Licence and contact

Copyright (c) H2Oil Engineering. All rights reserved.

This is **proprietary software** — not open source. See [LICENSE](LICENSE). The source code being
visible here grants no right to copy, modify, redistribute, host, reuse or build on it. End users
may use the official published applications (the H2Oil web app, the iOS app and the signed WTS
Modbus Bridge installers on the Releases page) for their own engineering work. For any other use,
ask for written permission.

**H2Oil Engineering**: software@h2oil.co.uk
