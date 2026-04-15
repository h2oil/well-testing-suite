# Engineering Calculators

This group covers equipment sizing and process engineering calculations commonly needed during well testing and production operations.

## Pump Sizing

Hydraulic pump sizing with Total Dynamic Head (TDH), NPSH analysis, and power calculation.

**Inputs:** Flow rate, fluid density, suction/discharge pressures, pipe friction, static head, pump efficiency, viscosity, temperature.

**Results:** TDH, hydraulic power (kW and HP), NPSH available, Reynolds number, pump type recommendation (centrifugal, PD, or multistage).

## Separator Rating

Souders-Brown gas capacity check and liquid retention time verification.

**Inputs:** Gas rate, oil rate, separator dimensions, operating pressure/temperature, gas SG, oil API, BSW, normal liquid level.

**Results:** Souders-Brown velocity, actual vs. allowable gas velocity (pass/fail), liquid retention time vs. minimum required (pass/fail), vessel utilisation percentages.

## Indirect Heater

Water bath heater duty calculation, fuel consumption, and heater category selection.

**Inputs:** Fluid type (oil, gas, water, or mixture), flow rates, inlet/outlet temperatures, specific heat, water cut, heater efficiency.

**Results:** Required duty (MMBtu/hr), fuel gas consumption, recommended heater size category.

## Pipe Sizing

Pipe selection based on velocity criteria and Darcy-Weisbach pressure drop.

**Inputs:** Flow rate, fluid density, viscosity, pipe length, allowable pressure drop.

**Results:** Table of standard pipe sizes with velocity, Reynolds number, friction factor, and pressure drop for each — highlighted pass/fail against velocity and dP limits.

## Turbine Meter

Liquid turbine meter sizing per API MPMS Chapter 5.3.

**Inputs:** Flow rate range (min/normal/max), fluid density, viscosity, operating pressure/temperature.

**Results:** Recommended meter size, Reynolds number at each flow condition, cavitation index, meter velocity, and pass/fail status for linearity and cavitation.

## Air Compressor

Compressor type selection and receiver sizing for instrument and utility air systems.

**Inputs:** Required free air delivery (CFM), system pressure, duty cycle, ambient conditions.

**Results:** Compressor type recommendation (reciprocating, screw, centrifugal), motor power, receiver tank volume.

## Generator Sizing

Generator kVA rating based on running loads and worst-case motor starting scenarios.

**Inputs:** List of motors (HP, quantity, power factor, starting method), non-motor loads, altitude, temperature derating.

**Results:** Total running kVA, worst-case starting kVA, required generator size with derating factors, load breakdown.

## Cable Sizing

Copper cable selection based on ampacity derating and voltage drop limits.

**Inputs:** Load current, voltage, power factor, cable length, ambient temperature, grouping, installation method.

**Results:** Recommended cable size (mm²), derated ampacity, voltage drop percentage, and pass/fail assessment.

## Voltage Drop

Verify voltage drop for copper or aluminium cable installations.

**Inputs:** Cable material, size, length, current, voltage, power factor.

**Results:** Voltage drop (volts and percentage), status assessment (OK / Warning / Fail).
