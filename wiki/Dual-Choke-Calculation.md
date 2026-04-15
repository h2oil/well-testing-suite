# Dual Choke Calculation

Calculates intermediate pressure, equivalent choke size, pressure drops, and flow rates for a dual (series) choke configuration.

## Inputs

| Parameter | Description | Units |
|---|---|---|
| Upstream Pressure (P1) | Pressure before the first choke | psi |
| Downstream Pressure (P2) | Pressure after the second choke | psi |
| Choke 1 Size | First choke opening | 64ths of an inch |
| Choke 2 Size | Second choke opening | 64ths of an inch |
| Flow Type | Gas or Oil | — |
| Gas SG / Oil API | Fluid property for rate estimation | — |

## Calculation Method

1. **Choke Areas** — Circular orifice area from choke sizes
2. **Intermediate Pressure (P3)** — Derived from area-weighted pressure balance
3. **Equivalent Choke** — Single choke that produces the same total pressure drop
4. **Pressure Drops** — Across each choke and total
5. **Pressure Ratios** — Per choke and combined
6. **Critical Flow Check** — Flags if pressure ratio < 0.55 (critical/sonic flow)
7. **Flow Rates** — Gilbert correlation for gas and oil estimation

## Results

- Intermediate pressure (P3)
- Equivalent choke size (64ths and decimal inches)
- Individual and total pressure drops and ratios
- Critical flow warnings
- Estimated gas (MSCF/D) and oil (BPD) rates
