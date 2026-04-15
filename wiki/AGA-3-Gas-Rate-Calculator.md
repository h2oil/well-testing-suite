# AGA-3 Gas Rate Calculator

Calculates orifice meter gas flow rate per **AGA Report No. 3 / API 14.3** with real-gas Z-factor and iterative discharge coefficient.

## Inputs

| Parameter | Description | Units |
|---|---|---|
| Pipe Internal Diameter (D) | Internal diameter of the meter run | inches |
| Orifice Bore Diameter (d) | Diameter of the orifice plate bore | inches |
| Static Pressure (Ps) | Upstream static pressure | psia |
| Flowing Temperature (Tf) | Gas temperature at the meter | °F |
| Differential Pressure (hw) | Differential across the orifice | inches H₂O |
| Gas Specific Gravity (SG) | Relative to air = 1.0 | dimensionless |
| CO₂ Mole Fraction | Carbon dioxide content | fraction |
| H₂S Mole Fraction | Hydrogen sulphide content | fraction |

## Calculation Method

1. **Beta Ratio** — `beta = d / D`
2. **Z-Factor** — Hall-Yarborough correlation using pseudo-reduced temperature and pressure (Piper-McCain-Corredor mixing rules for CO₂/H₂S)
3. **Discharge Coefficient (Cd)** — Reader-Harris/Gallagher equation with iterative convergence on Reynolds number
4. **Velocity of Approach (Ev)** — `1 / sqrt(1 - beta^4)`
5. **Expansion Factor (Y₁)** — Accounts for gas compressibility through the orifice
6. **Gas Density** — From real-gas law using Z-factor
7. **Volume Flow Rate** — AGA-3 master equation

## Results

- Discharge Coefficient (Cd)
- Expansion Factor (Y₁)
- Z-Factor
- Gas Density (lb/ft³)
- Flow Rate (ft³/hr, MSCF/D, MMSCF/D)

## Export

- **CSV** — Exports all inputs and results as comma-separated values
- **PDF** — Full report with cover page and results
