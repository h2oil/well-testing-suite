# PTA — Pressure Transient Analysis

Performs pressure transient analysis using three complementary methods.

## Analysis Methods

### 1. Horner Plot
Classic buildup analysis for estimating permeability and skin factor.

**Inputs:** Shut-in time and pressure data (paste from clipboard), producing time (tp), flow rate (q), formation volume factor (Bo), viscosity (mu), net pay (h), total compressibility (ct), porosity (phi), wellbore radius (rw), last flowing pressure (pwf).

**Results:**
- Semi-log straight line slope (m)
- Permeability (k) from slope
- Skin factor (s) from p1hr
- Extrapolated reservoir pressure (p*)

### 2. Log-Log Diagnostic (Bourdet Derivative)
Pressure change and Bourdet derivative plotted on log-log scale for flow regime identification.

**Inputs:** Same as Horner, plus the pressure-time data.

**Results:**
- Pressure change (dp) and derivative (dp') curves
- Flow regime identification:
  - **Wellbore storage** — unit slope on derivative
  - **Radial flow** — flat derivative (stabilisation)
  - **Linear flow** — half-slope on derivative
  - **Boundary effects** — late-time derivative behaviour

### 3. Superposition Time Analysis
Multi-rate analysis using superposition time function.

**Inputs:** Rate history (time and rate pairs), plus standard reservoir parameters.

**Results:**
- Permeability from superposition straight line
- Extrapolated reservoir pressure (p*)

## Charts

Each method produces a dedicated canvas chart:
- Horner: `(tp + dt) / dt` vs. pressure (semi-log)
- Log-Log: dt vs. dp and dp' (log-log)
- Superposition: superposition time vs. pressure

## Export

- **CSV** — Per-method data export
- **PDF** — Full report with chart and interpreted parameters
