# DCA — Decline Curve Analysis

Performs production decline curve analysis with multiple model types, confidence intervals, and EUR estimation.

## Supported Models

### Arps Decline
- **Exponential** (b = 0) — Constant percentage decline
- **Hyperbolic** (0 < b < 1) — Declining percentage decline
- **Harmonic** (b = 1) — Special case of hyperbolic

### Duong Model
Tight/unconventional reservoir decline model using the Duong (2011) rate-time relation:
- Parameters: a (intercept), m (slope)
- Well-suited for linear and bilinear flow regimes

### Stretched Exponential (SEPD)
- Parameters: qi (initial rate), tau (time constant), n (exponent)
- Captures multi-scale decline behaviour

## Inputs

| Parameter | Description |
|---|---|
| Initial Rate (qi) | Starting production rate |
| Decline Rate (Di) | Initial nominal decline rate (Arps) |
| b-exponent | Arps hyperbolic exponent |
| a, m parameters | Duong model coefficients |
| tau, n parameters | SEPD model coefficients |
| Forecast months | Duration of the forecast period |
| Rate unit | bbl/d, Mscf/d, or boe/d |

## Features

- **Auto-Fit** — Paste production data and auto-fit Arps parameters using least-squares regression
- **Confidence Bands** — High/low case forecasts shown as shaded regions on the chart
- **EUR Calculation** — Estimated Ultimate Recovery with confidence range
- **Interactive Chart** — Canvas-based rate vs. time plot with actual data overlay

## Export

- **CSV** — Time, rate, and cumulative production columns
- **PDF** — Full report with chart, parameters, and EUR summary
