# User Interface Guide

## Layout

The application uses a two-panel layout:

- **Sidebar** (left) — Navigation grouped by category
- **Main Area** (right) — Active calculator page with header and content

### Sidebar Navigation Groups

| Group | Modules |
|---|---|
| General | Dashboard, Client & Well Info |
| Metering | AGA-3 Orifice Meter, Dual Choke, Choke Flow |
| Well Testing | Bottoms Up, Solution GOR, Oil & Gas Rate, MCF & Shrinkage, Casing & Tubing |
| Production Analysis | DCA Decline Curves, PTA Pressure Analysis |
| Safety & Process | Flare Simulation, PRV Sizing, Vessel & Pipe, Flame Arrestor, ARC Valve |
| Engineering | Pump Sizing, Separator Rating, Indirect Heater, Pipe Sizing, Turbine Meter, Air Compressor, Generator Sizing, Cable Sizing, Voltage Drop |
| Field Calculations | Gas Calculations, Fluid Properties, Tank Calculator, Electrical & Pumps, Chemical & Dosage, Unit Conversions, Choke Conversions, Analog Signal |

### Mobile View

On screens narrower than 900px, the sidebar collapses into a **hamburger menu** accessible from the top-left corner. Tap any module to navigate — the drawer closes automatically.

## Common Controls

### Input Fields

- All numeric inputs include **validation** — invalid entries are highlighted in red with descriptive error messages.
- Inputs **auto-save** on every keystroke (throttled at 300ms) to `localStorage`.
- Saved values are restored automatically when you return to a page.

### Calculate Button

Each calculator has a primary **Calculate** button (orange). Click it to run the computation and display results.

### Results Display

Results appear in styled result boxes below the inputs. They typically include:
- Calculated values with units
- Status indicators (pass/fail, warnings)
- Notes explaining assumptions or limitations

### Charts

Several modules (DCA, PTA, Flare) include interactive **canvas-based charts**. These render directly in the browser using the HTML5 Canvas API — no charting library is used.

### Export Buttons

When viewing any calculator page (not the Dashboard or Client Info page), two export buttons appear in the top-right:

- **PDF** — Generates a professional multi-page report
- **PNG** — Renders a composite image of all inputs, charts, and results
