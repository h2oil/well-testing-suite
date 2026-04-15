# Choke Flow Rates

Calculates gas and oil flow rates through fixed chokes using industry-standard correlations.

## Gas Flow Rate

Uses the **orifice coefficient method** for gas flow through a fixed choke.

### Inputs
- Upstream pressure (psia)
- Downstream pressure (psia)
- Gas specific gravity
- Flowing temperature (°F)
- Choke size (64ths)
- Discharge coefficient

### Method
Accounts for critical vs. subcritical flow using the critical pressure ratio. Applies the general gas orifice flow equation with compressibility correction.

## Oil Flow Rate

Uses the **Gilbert equation** and **Ros correlation** for oil flow through a choke.

### Inputs
- Wellhead pressure (psig)
- Choke size (64ths)
- GOR (scf/bbl)

### Results
- Oil rate (BPD) from Gilbert
- Oil rate (BPD) from Ros
- Both correlations presented side-by-side for comparison
