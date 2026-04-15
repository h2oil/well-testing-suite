# PRV / Relief Valve Sizing

Sizes pressure relief valves per **API 520 Part I** with standard orifice selection from **API 526**.

## Service Types

### Gas / Vapour Service
Sizes the relief orifice for gas or vapour relief, handling both critical and subcritical flow.

**Key Inputs:** Required mass flow (W), molecular weight (M), specific heat ratio (k), set pressure (Ps), back pressure, inlet temperature (T), compressibility factor (Z), discharge coefficient (Kd), back-pressure correction (Kb), combination factor (Kc).

**Method:** Calculates critical flow pressure. If downstream pressure is below critical, uses critical flow equation; otherwise uses subcritical flow equation.

### Steam Service
Sizes the orifice for saturated or superheated steam relief.

**Key Inputs:** Required mass flow (W), set pressure (Ps), steam condition (saturated/superheated), superheat temperature, discharge coefficient (Kd), back-pressure correction (Kb), superheat correction (KSH), Napier correction (KN).

### Liquid Service
Sizes the orifice for liquid relief per API 520 liquid methodology.

**Key Inputs:** Required flow rate (Q), set pressure (Ps), back pressure, liquid specific gravity (Gl), viscosity (mu), discharge coefficient (Kd), back-pressure correction (Kw), combination factor (Kc), viscosity correction (Kv).

**Method:** Preliminary sizing followed by viscosity correction factor iteration.

### Inlet Pressure Drop Check
Verifies that the inlet piping pressure loss does not exceed 3% of set pressure (API 520 / ASME requirement).

## API 526 Orifice Selection

After calculating the required effective area, the calculator selects the next standard API 526 orifice letter designation (D through T) and reports the actual orifice area.

## Export

- **PDF** — Detailed sizing report per service type with all correction factors
