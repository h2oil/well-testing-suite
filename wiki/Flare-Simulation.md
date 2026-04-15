# Flare Simulation

Interactive flare radiation model based on **API 521** for thermal radiation zone analysis.

## Features

- **2D and 3D visualisation** — Toggle between plan-view 2D canvas and perspective 3D rendering
- **Thermal radiation contours** — Colour-coded zones showing radiation intensity at ground level
- **Noise prediction** — Flare noise level estimation with distance-based attenuation
- **Background image overlay** — Load a site drawing/satellite image as a background, with configurable scale, offset, and opacity
- **Custom radiation thresholds** — Add/remove threshold levels for radiation zone display

## Inputs

| Parameter | Description | Units |
|---|---|---|
| Gas Flow Rate | Flare gas flow rate | MMSCF/D |
| Heat Value | Lower heating value of the gas | BTU/SCF |
| Stack Height | Height of the flare tip | ft |
| Stack Diameter | Internal diameter of the flare stack | inches |
| Wind Speed | Ambient wind speed | mph |
| Ambient Temperature | Air temperature | °F |
| Humidity | Relative humidity | % |
| Emissivity / Fraction Radiated | Fraction of heat radiated | — |

## Calculation Method

1. **Heat Release** — Total heat from flow rate and heating value
2. **Flame Length** — API 521 flame length correlation
3. **Flame Tilt** — Wind-induced deflection of the flame
4. **Point Source Model** — Thermal radiation intensity at any ground-level point based on distance to the flame centre
5. **Radiation Zones** — Contour mapping at defined thresholds (e.g., 500, 1500, 3000 BTU/hr/ft²)
6. **Noise** — Sound pressure level estimation considering combustion noise and atmospheric attenuation

## Export

- **CSV** — Radiation intensity at key distances
- **PDF** — Report including the 2D flare plot, radiation zones, and noise data
