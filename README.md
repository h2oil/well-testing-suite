# Well Testing Suite — H2Oil Engineering

A comprehensive, browser-based engineering calculator suite designed for well testing, production analysis, and oilfield engineering. Built as a single self-contained HTML file with zero external dependencies.

## Overview

The Well Testing Suite provides **35+ engineering calculators** covering metering, production analysis, safety/process design, equipment sizing, and field calculations — all running entirely in the browser with no server, no install, and no internet connection required.

Developed by **H2Oil Engineering** (`software@h2oil.co.uk`).

## Quick Start

1. Open `well-testing-app.html` in any modern browser (Chrome, Firefox, Edge, Safari).
2. Select a calculator from the sidebar navigation.
3. Enter your parameters and click **Calculate**.
4. Export results as **PDF** or **PNG**, or save/load full sessions.

No build step, no dependencies, no server — just open the file and go.

## Features

### Calculators

| Category | Modules |
|---|---|
| **Metering** | AGA-3 Gas Rate Calculator, Dual Choke Calculation, Choke Flow Rates |
| **Production Analysis** | DCA — Decline Curve Analysis (Arps, Duong, Stretched Exponential), PTA — Pressure Transient Analysis (Horner, Log-Log, Superposition) |
| **Safety & Process** | Flare Simulation (API 521), PRV / Relief Valve Sizing (API 520), Vessel & Pipe (ASME), Flame Arrestor Sizing, ARC Valve Sizing |
| **Engineering** | Pump Sizing, Separator Rating, Indirect Heater, Pipe Sizing, Turbine Meter, Air Compressor, Generator Sizing, Cable Sizing, Voltage Drop |
| **Well Testing** | Bottoms Up Time, Oil & Gas Rate + GOR, MCF & Shrinkage %, Casing & Tubing |
| **Reservoir** | Solution GOR, Fluid Properties (API gravity, bubble point, shrinkage) |
| **Field Calculations** | Gas Calculations, Tank Calculator, Electrical & Pumps, Chemical & Dosage, Unit Conversions, Choke Conversions, Analog Signal Conversions |

### Platform Features

- **Zero Dependencies** — Single HTML file, pure vanilla JavaScript, no frameworks or libraries
- **Offline-Ready** — Works without an internet connection; all logic runs client-side
- **Auto-Save** — Every input is automatically persisted to `localStorage` on each keystroke
- **PDF Export** — Professional reports with H2Oil branding and client/well information
- **PNG Export** — Composite image export of charts and results for presentations
- **Session Export/Import** — Save and restore all calculator states as a `.txt` file for sharing between machines or colleagues
- **Client & Well Info** — Dedicated page for project metadata that appears on all exported reports
- **Client Logo Upload** — Attach a client logo for co-branded PDF report cover pages
- **Interactive Charts** — Canvas-based charts for DCA decline curves, PTA diagnostics, and flare simulations
- **Dark Theme** — Full dark UI designed for extended use
- **Mobile Responsive** — Hamburger menu and responsive layout for tablet/phone use

## Architecture

```
well-testing-app.html    # Single self-contained file (~5,750 lines)
├── <style>              # Full CSS including responsive breakpoints
├── <body>               # Sidebar navigation + main content area
└── <script>             # IIFE-wrapped vanilla JS application
    ├── Helpers          # DOM utilities, formatting, validation
    ├── LocalStorage     # Auto-save, session export/import
    ├── Navigation       # SPA-style page routing
    ├── Chart Engine     # Canvas-based line/scatter chart renderer
    ├── PDF Engine       # Client-side PDF generation (no libraries)
    ├── PNG Export       # Offscreen canvas composite renderer
    └── 35+ Renderers    # One render function per calculator module
```

The entire application is wrapped in an [IIFE](https://developer.mozilla.org/en-US/docs/Glossary/IIFE) with `"use strict"`. Public functions (button handlers) are explicitly assigned to `window.*`.

## Key Standards & References

| Calculator | Standard / Reference |
|---|---|
| AGA-3 Gas Rate | AGA Report No. 3 / API 14.3 |
| PRV Sizing | API 520 Part I, API 526 |
| Flare Simulation | API 521 |
| Vessel / Pipe | ASME BPVC Section VIII |
| DCA | Arps (1945), Duong (2011), Stretched Exponential |
| PTA | Horner method, Bourdet derivative |
| Turbine Meter | API MPMS Chapter 5.3 |
| Fluid Properties | Standing, Vasquez & Beggs correlations |

## Browser Support

Tested on all modern evergreen browsers:

- Google Chrome 90+
- Mozilla Firefox 90+
- Microsoft Edge 90+
- Safari 14+

## Data & Privacy

All data stays in your browser. Nothing is transmitted to any server. Calculator inputs are stored in the browser's `localStorage` — clearing browser data will remove saved values. Use **Export Session** to back up your work.

## License

Proprietary — H2Oil Engineering. All rights reserved.

## Contact

**H2Oil Engineering**
Email: software@h2oil.co.uk
