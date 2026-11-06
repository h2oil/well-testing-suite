// Help: simulator course + field scenarios (HELP-GUIDE-PLAN §6); checked by tests/help-course.test.js. EQ: sim-equip only.
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    G.WTS_helpContent = G.WTS_helpContent || { guides: {}, factories: [] };
    G.WTS_helpContent.factories = G.WTS_helpContent.factories || [];
    G.WTS_helpContent.factories.push({ group: 'simcourse', routes: [], build: function () {
    var BASE = 'Base set-up: select **Restore full rig-up** in the **Rig-up** card, keep the form defaults, select **Reset → Reset to steady**, then **Alarms → Ack all**.';
    var DEF = { wts_Pwh: 3000, wts_Twh: 180, wts_Qg: 10, wts_Qo: 1000, wts_Qw: 200, wts_bean: 32, wts_bypass: '0', wts_Psep: 150, wts_Psurge: 25 };
    var course = [
        { id: 'ex1', title: 'Normal test: line up, stabilise and read the spread', keywords: ['HUD', 'critical flow', 'set point', 'reading'],
            goal: 'Find every reading of a normal test and explain why the choke is in critical flow.',
            setup: [BASE, 'Select **2D**: the clearest view on a projector.'],
            steps: ['Check the clock runs (**Play**) at speed **×10**.', 'Read the HUD: **WHP**, **Choke in→out**, **Sep**, **Surge**, then **Gas**, **Oil**, **Water**, **GOR** and **BS&W**.',
            'Select CK-101 in the view to open its card. Read **Regime**, **Downstream P**, **Capacity** and **J-T ΔT**.',
            'Select V-101. On its card select **+** twice next to **PCV-101 SP** ({{160|pressureG}}) and watch **Setpoint** ramp.',
            'Follow the trends strip below the schematic (in 3D, select **Trends**) for 10 minutes of sim time. Then set the SP back to {{150|pressureG}}.'],
            observe: ['Choke outlet about {{158|pressureG}} against {{2999|pressureG}} at the inlet: P2/P1 0.057, far below 0.55, so the regime is **Critical**.',
            'Capacity {{10.71|gasRate}} for {{10|gasRate}} asked: the bean is not limiting.', 'J-T cooling about {{111|tempDelta}}: choke outlet about {{69|temperature}}, heater outlet {{150|temperature}}.',
            'The set point ramps at about {{2|pressure}} per second and the separator pressure follows it.'],
            questions: ['Why does a separator set point of {{160|pressureG}} not change the gas rate?', 'What is the choke ΔP, and where does most of the cooling happen?', 'Which reading warns you that the bean is near its limit?'],
            answers: ['In critical flow the rate does not depend on the back pressure (P2/P1 stays below about 0.55).', 'About {{2842|pressure}}. Most of the cooling is J-T across the choke.',
            '**Capacity** on the CK-101 card, and the choke capacity bar, against the gas rate.'],
            blocks: [{ h: 'How the simulator works' },
            'The simulator is a dynamic replay around a steady design calculation. The page form feeds that calculation: it walks from the wellhead to the choke and back-walks the choke outlet from the separator **Operating Pressure**.',
            'Gas, oil and water rates are inputs. The bean is checked against the gas rate only; if it is too small, all three rates are cut by the same factor. Form changes apply live, without a Reset, and show in Events.',
            'Use it to practise operating the surface spread: line-ups, levels, pressures, alarms, ESD, tank gauging, upsets and hydrates. It does not predict what a well will make on a bean.',
            'On a phone, Reset, Scenarios, Colour, View and Trends are in the **More** menu.',
            { details: { summary: 'Using this course with a crew', body: ['The course is self-paced. A trainer can run it for a crew, in a class or on a projector (2D view), with the trainer notes and the printed worksheets. Questions about the course: {{email}}.'] } }],
            form: DEF, trainer: { duration: '20–30 minutes.', fault: 'None. Ask the crew to call out each reading as on a real job.',
            good: 'Reads WHP, choke in and out, separator pressure against SP, levels and rates without help, and explains critical flow.',
            mistakes: ['Expecting the rate to change with the separator pressure.', 'Taking the choke upstream pressure for the wellhead pressure.'],
            debrief: ['What would make this choke go subcritical?', 'Which readings would you log every 15 minutes?', 'Where would you look first if GOR jumped?'] } },
        { id: 'ex2', title: 'Choke capacity and bean selection', keywords: ['bean', 'CHOKE_LIMIT', 'capacity', 'flow-limited'],
            goal: 'See what happens when the bean is too small for the gas rate, and size it back.',
            setup: [BASE],
            steps: ['Select CK-101 in the view to open its card.', 'Select **−** once: the bean goes to 30/64.', 'Open **Alarms**. Watch CHOKE_LIMIT and the HUD **Gas**, **Oil** and **Water**.',
            'Select **−** again (28/64) and read **Capacity**.', 'Select **+** until the alarm clears (32/64), then once more (34/64): it stays clear.'],
            observe: ['On 30/64 the capacity is {{9.41|gasRate}}: CK-101 raises CHOKE_LIMIT and gas, oil and water are all cut by about 6 %.',
            'Capacity follows the bean area: 10.71 × (30/32)² ≈ 9.41.', 'The design warnings in **Alarms** say “Choke is flow-limited — bean 30/64”.'],
            questions: ['What capacity do you expect on 28/64?', 'Why does the oil rate fall when only the gas capacity is short?', 'Can this check limit a liquid-only flow?'],
            answers: ['10.71 × (28/32)² ≈ {{8.2|gasRate}}.', 'The model scales the whole stream to the gas capacity.', 'No. The check compares the gas rate only, so the bean never limits a liquid rate.'],
            form: DEF, trainer: { duration: '15–20 minutes.', fault: 'Variant: before the session set **Bean Size** to 28 in the form, so the trainee finds CHOKE_LIMIT active and diagnoses it.',
            good: 'Reads Capacity against the gas rate and clears the alarm with the smallest bean that passes it.',
            mistakes: ['Raising the bean far past the need.', 'Thinking the liquid rate sets the bean.'],
            debrief: ['How do you size a bean before the test?', 'What does a flow-limited choke do to the test data?', 'What else changes on a larger bean?'] } },
        { id: 'ex3', title: 'Clean-up: unload the cushion to the burner (V-101 out)', keywords: ['cushion', 'burner', 'clean-up', 'unload', 'bypass'],
            goal: 'Unload the completion cushion straight to the burner boom with the right pressures, then go through the separator.',
            setup: ['Base set-up as in exercise 1.'],
            steps: ['Follow [[fs#FS-1|FS-1]] steps 1 to 8 in that order: Surge Tank Pressure in two steps, then Operating Pressure, then V-101 out, and the restore step before V-101 goes back in.'],
            observe: ['The V-101 card says it is bypassed and the Rig-up note explains why there are no meter rates or batches.', 'The HUD total water against the cushion volume.',
            'The choke outlet with V-101 out is about {{10|pressureG}}, not the {{21|pressureG}} of the steady check.'],
            questions: ['Where do the flowing wellhead pressure and the production-line pressure go?', 'Why must Operating Pressure be low while V-101 is out?',
            'How long does a {{150|volume}} cushion take at {{2400|liquidRate}}?', 'What do you do before you put V-101 back in?'],
            answers: ['FWHP in **Wellhead Pressure**; line pressure in **Operating Pressure**, with V-101 in only.', 'The steady choke check still back-walks from it, and it sets the Surge Tank Pressure limit.',
            'About 1.5 hours (cushion volume ÷ the rate actually flowing).', 'Set Operating Pressure back to the test pressure and Surge Tank Pressure to {{25|pressureG||imp}}, and let them stabilise.'],
            form: DEF, trainer: { duration: '30–40 minutes.', fault: 'None at first. Then ask when to go through the separator: the answer is clean, stable returns, not a warning. Variant: ask for full rate on the bypass and let the trainee find the choke and velocity limits.',
            good: 'Lowers Surge Tank Pressure, then Operating Pressure, before switching V-101 out; unloads on a bean that does not limit; restores the pressures before V-101 goes back in.',
            mistakes: ['Putting the production or flowing pressure in Operating Pressure.', 'Lowering Operating Pressure before Surge Tank Pressure, or after V-101 is out (ESD trip).', 'Switching V-101 in at {{15|pressureG}}.'],
            debrief: ['What is the real back pressure of your burner line?', 'What tells you the cushion is out?', 'When is it time to go through the separator?'] } },
        { id: 'ex4', title: 'Separator upset: dump valve failure', keywords: ['LCV-102', 'LSHH', 'dump valve', 'upset', 'trip'],
            goal: 'Recognise a dump valve that does not open, act before the trip, and restart after it.',
            setup: [BASE],
            steps: ['Run at **×10** for about 10 minutes of sim time.', 'The trainer sets **Scenarios → LCV-102 stuck closed**.', 'Watch the V-101 card: **Oil bucket** rises, **Oil dump** stays at 0.',
            'At LAH-102 decide: cut the rate or shut in with **ESD** before LSHH-102.', 'After the trip select **Reset ESD**. It is refused while LSHH-102 is active.',
            'Clear the fault (select it again), wait for the bucket to fall, **Ack all**, then **Reset ESD**.'],
            observe: ['LAH-102 about 3 minutes after the fault; LSHH-102 trips the ESD less than a minute later.', 'The ESD button tooltip lists the active trips that block the reset.', 'Events records the fault, the alarms, the trip and the reset.'],
            questions: ['Which reading showed the cause before any alarm?', 'Why is the reset refused?', 'What would a stuck-closed LCV-101 look like?'],
            answers: ['Oil dump at 0 while the bucket level rises.', 'A trip alarm is still active; the ESD resets only when every trip has cleared.', 'The interface rises to LAHH-101 and water carries over the weir; it does not trip the ESD.'],
            form: DEF, trainer: { duration: '20 minutes.', fault: 'At about 10 minutes of sim time: **Scenarios → LCV-102 stuck closed**, with the projector blanked.',
            good: 'Spots Oil dump at 0, names LCV-102, shuts in under control and resets in the right order.',
            mistakes: ['Acknowledging alarms without reading them.', 'Trying Reset ESD again and again.'],
            debrief: ['What would you check on a real LCV-102?', 'How long did you have between LAH and LSHH?', 'What does a trip cost the test?'] } },
        { id: 'ex5', title: 'ESD and restart', keywords: ['ESD', 'SDV-101', 'shut-in', 'restart', 'build-up'],
            goal: 'Shut in with the ESD, watch the wellhead pressure build and bring the well back.',
            setup: [BASE],
            steps: ['At steady flow select **ESD** in the toolbar.', 'Open the SDV-101 card and watch **Travel**.', 'Watch **WHP** on the HUD for 5 minutes of sim time.',
            'Select **Reset ESD**.', 'Watch the flow return and the alarms during the start-up.'],
            observe: ['SDV-101 closes in 5 seconds and opens in 15 seconds.', 'WHP builds toward 1.2 × the flowing WHP (time constant 300 seconds): about {{3300|pressureG}} after 5 minutes.',
            'After the reset, low alarms are held off for a 180-second start-up grace.'],
            questions: ['Why does WHP rise after the shut-in?', 'Why are low-pressure and low-level alarms held off after the reset?', 'What do you check before you reopen a real well?'],
            answers: ['The well keeps feeding the tubing, so pressure builds toward the shut-in pressure.', 'Levels and pressures need time to come back; without the grace they would alarm at every start.',
            'The cause is cleared, the line-up is right and the downstream pressure is ready.'],
            form: DEF, trainer: { duration: '15 minutes.', fault: 'None, or trip the ESD yourself at an unexpected time and ask for the restart.',
            good: 'Confirms SDV-101 is shut, logs the shut-in pressure and restarts in order.',
            mistakes: ['Resetting before reading the cause in Events.', 'Expecting full flow at once after the reset.'],
            debrief: ['What would the build-up tell a reservoir engineer?', 'Which trips should never be reset from the panel?', 'What is the order of a restart on your spread?'] } },
        { id: 'ex6', title: 'Tank gauging and batch rates', keywords: ['gauge tank', 'batch', 'shrinkage', 'T-301', 'P-201'],
            goal: 'Read a gauge tank batch and compare it with the separator meter.',
            setup: [BASE],
            steps: ['Run at **×60** for about 2 hours of sim time.', 'Open the T-301 card. Watch T-301A fill to 90 %, then the inlet change to B.',
            'Watch A go to SETTLING, then DRAINING through P-201.', 'Read **Last batch**, **BS&W** and **Shrinkage**, and the batch entry in **Events**.',
            'Variant: the trainer sets **Scenarios → P-201 failed (gauge tank pump)**; run on until LAH-301 and LSHH-301.'],
            observe: ['The first batch closes after about 1.3 hours at the default rates and settles for 10 minutes.', 'The tank oil rate is below the meter oil rate: gas flashes off in the tanks (shrinkage).',
            'LSHH-301 shuts the LCV-201 transfer but does not trip the ESD.'],
            questions: ['Why do the tank and the meter disagree?', 'Why wait before you gauge?', 'What happens to the separator when T-301 is full?'],
            answers: ['The meter reads live oil at separator conditions; the tank holds stock-tank oil after flash.', 'Gas and water need time to separate before a dip or a strap is taken.',
            'LCV-201 stops; the surge tank then fills, so watch its level.'],
            form: DEF, trainer: { duration: '30 minutes.', fault: 'Variant: after the first batch, **Scenarios → P-201 failed (gauge tank pump)**.',
            good: 'Reads the batch and explains shrinkage; with P-201 failed, plans the next tank before LSHH-301.',
            mistakes: ['Gauging a tank that is still settling.', 'Reporting the meter rate as the tank rate.'],
            debrief: ['How do you correct a tank batch to standard conditions?', 'What makes the meter factor drift?', 'What do you do with no pump?'] } },
        { id: 'ex7', title: 'Surge tank operation', keywords: ['surge tank', 'T-201', 'LCV-201', 'divert', 'low ΔP'],
            goal: 'Run the surge tank transfer, change compartments safely and spot a transfer problem.',
            setup: [BASE],
            steps: ['Open the T-201 card. Read **Level (A+B)**, **Pressure**, **Transfer** and **Transfer ΔP**.',
            'Under **Inlet** select B to shut it, so only A fills. Now change over: select B, then A at once. A stays open until B is fully open (open new, then close old). Select A again so both are open.',
            'The trainer sets **Scenarios → LCV-201 stuck closed (surge transfer)**. Watch the level rise and **Time to HH**.', 'Clear the fault before LSHH-201, or watch it trip the ESD.',
            'Pause, set **Surge Tank Pressure** to {{2|pressureG||imp}} in the form, select **Reset → Reset to steady**, then play and watch **Transfer ΔP**. Lowered by {{23|pressure||imp}} while running, PSHH-201 would trip the ESD.'],
            observe: ['LCV-201 has no pump: it transfers on the surge tank pressure plus the liquid head.', 'With LCV-201 stuck closed, LSHH-201 trips the ESD about an hour later at the default rates.',
            'At {{2|pressureG||imp}} the transfer ΔP falls to about {{1|pressure}} and LCV-201 raises a low ΔP warning.'],
            questions: ['Why open the new inlet before closing the old one?', 'What drives the transfer to the gauge tank?', 'What would you change for a low-pressure surge tank?'],
            answers: ['So the separator dumps are never blocked during the change.', 'The surge tank pressure and the liquid head, against the lift to the gauge tank inlet.', 'Keep enough pressure for the lift, or plan for a slower transfer.'],
            form: DEF, trainer: { duration: '25 minutes.', fault: 'At about 10 minutes of sim time: **Scenarios → LCV-201 stuck closed (surge transfer)**.',
            good: 'Reads Time to HH, reacts before LSHH-201 and changes compartments in the right order.',
            mistakes: ['Shutting both inlets.', 'Ignoring the low ΔP warning.'],
            debrief: ['What protects the surge tank from overpressure?', 'How long can you run with no transfer?', 'Where does the flash gas go?'] } },
        { id: 'ex8', title: 'Hydrates and the heater', keywords: ['hydrate', 'J-T', 'heater', 'bypass', 'cold'],
            goal: 'See where hydrates can form, and what the heater does about it.',
            setup: [BASE],
            steps: ['In the form set **Wellhead Temp** to {{60|temperature}} (live, no Reset).', 'Watch the choke outlet temperature and the hydrate alarms in **Alarms**.',
            'Open the H-101 card and select **Bypass** (ON). See how far the hydrate risk spreads.', 'Select **Bypass** again (OFF). Watch the heater outlet warm back up.',
            'In 3D select **Colour → Temperature**.'],
            observe: ['J-T cooling of about {{111|tempDelta}} takes the choke outlet to about {{-51|temperature}}, against a hydrate point of about {{37|temperature}}.',
            'Even upstream of the choke, {{60|temperature}} is below the {{75|temperature}} hydrate point at {{3000|pressureG}}.', 'With the heater in, the risk ends at the heater; bypassed, it reaches the separator and the flare line.',
            'At {{180|temperature}} wellhead temperature the outlet is about {{69|temperature}}: about {{32|tempDelta}} of margin.'],
            questions: ['Why is the heater downstream of the choke not enough here?', 'What else could protect the choke?', 'Why does the margin grow as the well warms up?'],
            answers: ['The coldest point is the choke outlet, before the heater.', 'Inhibitor injection upstream of the choke: see [[hydrate]] and [[cheminj]].', 'A hotter stream leaves the choke above the hydrate point.'],
            form: DEF, trainer: { duration: '20 minutes.', fault: 'None. Variant: start with the heater bypassed and ask for a safe start-up plan.',
            good: 'Finds the coldest point, puts the heater in and asks for inhibitor at the choke.',
            mistakes: ['Looking only at the separator temperature.', 'Bypassing the heater to save fuel on a cold well.'],
            debrief: ['Where would you inject inhibitor on your spread?', 'How does the choke outlet temperature change with the bean?', 'What is your hydrate margin rule?'] } }
    ];
    var PRESS = { table: { head: ['The pressure you have', 'Where it goes', 'Rig-up', 'Scenario'], rows: [
        ['Flowing wellhead or tubing pressure (FWHP, FTHP, flowing pressure)', '**Wellhead Pressure**, never the separator pressure', 'any', 'all'],
        ['Production or export line pressure (the header the well flows into)', 'Separator **Operating Pressure**, plus the line loss to the header', 'V-101 in only', '[[fs#FS-2|FS-2]]'],
        ['Burner boom (cushion or clean-up straight to the burner)', 'No line pressure: **Surge Tank Pressure** {{5|pressureG||imp}} first (in two steps), then **Operating Pressure** low ({{15|pressureG}}), then V-101 out', 'V-101 out', '[[fs#FS-1|FS-1]]']] } };
    var CTRL = { table: { head: ['What Operating Pressure controls', 'V-101 in', 'V-101 out (to the burner)'], rows: [
        ['Live model: PCV-101 set point and separator pressure', 'yes', 'no (PCV-101 held shut)'],
        ['Live model: separator alarms and relief (PAH, PSHH, PAL, PSV)', 'set from it', 'live on the trapped vessel: lowering it trips PSHH-101'],
        ['Live model: choke outlet pressure', 'separator pressure + line losses', '{{5|pressureG}} burner header + Sep→Flare loss + (steady choke outlet − Operating Pressure)'],
        ['Steady check: choke regime, capacity, J-T, temperatures, hydrate margins, velocities', 'yes', 'yes, still: set it near the burner back pressure'],
        ['Surge Tank Pressure limit: at most the smaller of {{30|pressureG||imp}} and Operating Pressure − {{10|pressure||imp}}', 'yes', 'yes, still']] } };
    var scenarios = [
        { id: 'FS-1', title: 'Unloading the completion cushion straight to the burner boom', feature: 'bypassDest',
            keywords: ['cushion', 'burner', 'boom', 'clean-up', 'unload', 'production pressure', 'separator pressure', 'bypass'],
            intro: [{ h: 'Which pressure goes where' }, 'Well testers use “production pressure” for two different things, so check which one you have.', PRESS, CTRL],
            today: [{ h: 'Order matters' }, 'Lower the pressures with V-101 in, Surge Tank Pressure first. Each of these trips the ESD:',
            { list: ['lowering **Operating Pressure** before **Surge Tank Pressure**;', 'lowering Surge Tank Pressure by more than {{10|pressure||imp}} at a time;', 'lowering Operating Pressure after V-101 is out;', 'a big step in the well rates while V-101 is in.'] },
            { list: ['Lower **Surge Tank Pressure** to {{15|pressureG||imp}}, wait for T-201 to come down to it, then set {{5|pressureG||imp}}. PSHH-201 follows the set point faster than T-201 vents. The field is in psig, also in Metric mode.',
            'Set **Operating Pressure** to {{15|pressureG}}, about the burner-line back pressure (up to {{20|pressureG}} is fine), and let the separator settle.',
            'Rig-up: switch V-101 (Test separator) out. FS-401 stays in. PCV-101 is now held shut and PSHH-101 still follows Operating Pressure.',
            'Unload inputs (live, no Reset): **Gas Rate** {{0.3|gasRate}}, **Condensate / Oil** 0, **Water Rate** {{2400|liquidRate}}, **Wellhead Pressure** = the flowing WHP ({{500|pressureG}}), bean 32. Steady check: **Critical** (P2/P1 0.068), capacity {{1.78|gasRate}}, choke downstream {{21|pressureG}}, no warnings. Live choke outlet: about {{10|pressureG}}.',
            'Run at **×60** until the HUD total **Water** reaches the cushion volume: {{150|volume}} at {{2400|liquidRate}} takes about 1.5 hours. An LCV-201 low ΔP warning is harmless here.',
            'CHOKE_LIMIT on CK-101 cuts all three rates by the same factor: raise the bean or lower the rate. Here it appears at a WHP of about {{60|pressureG}} ({{0.25|gasRate}}) and clears at {{100|pressureG}} ({{0.39|gasRate}}).',
            'Clean-up: set the expected rates, e.g. {{5|gasRate}}, {{500|liquidRate}} oil, {{300|liquidRate}} water, WHP {{2000|pressureG}}: Critical, capacity {{7.21|gasRate}}, choke downstream {{24|pressureG}}, no warnings. Go through the separator once the returns are clean and stable: BS&W and solids low and steady at a steady WHP and rate.',
            'Restore before V-101 goes back in: **Operating Pressure** {{150|pressureG}} and **Surge Tank Pressure** {{25|pressureG||imp}} (raising them is safe), let them settle, then switch V-101 in.'], ordered: true },
            'The bypass rate has a limit. At {{10|gasRate}} with the clean-up values the page shows ⚠ “Choke is flow-limited — bean 32/64″…” and ⚠ “Heater→Sep: Velocity 291 ft/s EXCEEDS erosional limit 259 ft/s”.',
            { h: 'Limits' }, 'The cushion itself is not modelled: no cushion density, no tail, and WHP does not rise by itself as the column unloads. The choke check uses the gas rate only, so the bean never limits the liquid rate.'],
            afterSim: ['In the Dynamic Simulation card choose **With V-101 out, well stream to → Burner / flare line**, then run **Scenarios → Cushion unload (clean-up)** with the cushion volume, SG and unload rate. The steady choke check then uses the real back pressure, so the low Operating Pressure and the restore step are not needed.'] },
        { id: 'FS-2', title: 'Flowing straight to a production line', feature: 'bypassDest',
            keywords: ['production line', 'export line', 'header', 'production pressure', 'line pressure', 'back pressure'],
            intro: [{ h: 'Which pressure goes where' }, 'The flowing wellhead pressure always goes in **Wellhead Pressure**. The production-line pressure goes in **Operating Pressure**, with V-101 in.', PRESS],
            today: [{ h: 'What is valid' }, 'Keep V-101 in and set **Operating Pressure** = the production-line pressure plus the header line loss. This is right for the choke: ΔP, regime, capacity, J-T, hydrate margins and the upstream velocities.',
            'In critical flow (P2/P1 below about 0.55) the rate does not depend on the back pressure. The default spread shows it: at {{150|pressureG}} the choke downstream is {{158|pressureG}}, P2/P1 0.057, Critical.',
            { h: 'Closest rig-up' }, 'V-101 in at that pressure, FS-401 out (gas to the export line), T-201 and T-301 out (liquids straight to the export line).',
            { h: 'What it gets wrong' }, { list: ['It still separates and meters the stream (meters, GOR, BS&W).', 'PCV-101 holds the pressure constant, unlike a real header.',
                    'The gas path after PCV-101 is still modelled at the {{5|pressureG}} header.',
                    'The separator alarm and relief set points follow the set point: PSHH = SP + the larger of 20 % and {{25|pressure}}; PAH = SP + the larger of 10 % and {{15|pressure}}; PAL = SP − the larger of 20 % and {{20|pressure}}; PSV and MAWP = the larger of {{1440|pressureG}} and 1.25 × PSHH. They do not represent the real header protection.',
                    'The Surge Tank Pressure limit moves with the set point.'] },
            { h: 'Not possible today' }, '“No separator, straight to the production line.” The rig-up puts FS-401 back in when V-101 and FS-401 are both out.'],
            afterSim: ['Switch V-101 out and choose **With V-101 out, well stream to → Production line**, with the **Production line pressure**. FS-401 may then be out too, and the totals go to “To production line”.'] },
        { id: 'FS-4', title: 'Cold start-up and hydrates', keywords: ['cold', 'start-up', 'hydrate', 'heater', 'inhibitor'],
            intro: ['A well that has been shut in arrives cold at the choke, and J-T cooling takes the choke outlet far below the hydrate point. Plan the heater and the inhibitor before you open up.'],
            today: [{ list: ['Start with **Wellhead Temp** {{60|temperature}} and the heater **Bypass** set to “Yes — Full Bypass”, as before the heater is lit.',
            'The steady check shows hydrate risk from the wellhead to the flare line. The choke outlet is about {{-51|temperature}} against a hydrate point of about {{37|temperature}}.',
            'Put the heater in (**Bypass** No). Downstream of the heater the risk clears, but WH→ESD, ESD→Choke and Choke→Heater still warn.',
            'Protect the choke with inhibitor upstream of it: work out the margin on [[hydrate]] and the injection rate on [[cheminj]].',
            'As the well warms to {{180|temperature}}, the choke outlet rises to about {{69|temperature}} and the warnings clear.'], ordered: true },
            'In the simulator the H-101 card shows the heater warming up over several minutes; train the crew on [[course#ex8|exercise 8]].',
            { h: 'Limits' }, 'The simulator raises hydrate alarms; it does not model a hydrate plug building up or the inhibitor itself.'] }
    ];
    var S = G.WTS_sim, O = (S && S.RIG_OPTIONAL) || [], EQ = O.indexOf('desander') >= 0 && O.indexOf('surge2') >= 0;
    if (!EQ) return { guides: {}, course: course, scenarios: scenarios };
    var DS = '**Scenarios → Sand / proppant flow-back (clean-up)**', OUT = function (n) { return 'Finally switch **' + n + '** out in **Rig-up**: **Restore full rig-up** does not remove it.'; };
    course.push({ id: 'ex9', title: 'Sand and the desander DS-101', keywords: ['sand', 'desander', 'DS-101', 'proppant', 'dump', 'erosion'],
        goal: 'Catch flow-back sand upstream of the choke, dump the accumulator safely and see what a bypass does to the bean.',
        setup: [BASE, 'In the **Rig-up** card switch **Cyclonic desander (upstream of the choke)** in. DS-101 sits between SDV-101 and CK-101.'],
        steps: ['Open the DS-101 card. Read **ΔP**, **Cut size**, **Capture** and **Rating**.', 'Start ' + DS + ' and run at **×60**. Watch **Accumulator** and the HUD line DS-101 sand.',
            'At LAH-103 select **Dump sand** and confirm. Follow **Dump**: ISOLATING, BLEEDING, FLUSHING, EQUALISING, REOPENING.',
            'After the dump set **Bypass** ON for 2 minutes and watch **To choke** and **Choke erosion**. Then set it OFF.', 'Variant: select **ESD** during a dump: it is HELD. After **Reset ESD** select **Resume dump** or **Abort dump**.', OUT('Cyclonic desander (upstream of the choke)')],
        observe: ['Clean ΔP about {{3.9|pressure|1}}, cut size about 40 µm, capture about 95 % of the formation sand. The choke inlet is lower by the ΔP; the ESD node is not.',
            'LAH-103 about 3.5 hours after the flow-back starts, at 80 % of the {{663|mass}} accumulator (about {{530|mass}}).',
            'The dump takes about 17 minutes and the well keeps flowing. XV-103 opens only below {{50|pressureG}} in the accumulator; the isolation reopens once the accumulator is within {{75|pressure}} of the desander.',
            'Bypassed, all the sand reaches the bean: a CK-101 sand alarm, **Choke erosion** HIGH. In line again: OK.'],
        questions: ['Why is the desander upstream of the choke?', 'Why bleed the accumulator before XV-103 opens?', 'What rating does DS-101 need, and why?', 'When may you bypass it?'],
        answers: ['Sand erodes the bean fastest (highest velocity); catching it upstream protects it.', 'XV-103 dumps to an open skip: at wellhead pressure the sand and gas would blow out.',
            'At least the maximum shut-in wellhead pressure: SDV-101 is its only shut-in and it has no relief valve. PSHH-103 trips the ESD if the inlet reaches the rating.', 'For maintenance, or once the well is sand-free.'],
        form: DEF, trainer: { duration: '30–40 minutes.', fault: 'After the first dump: **Scenarios → XV-103 stuck closed (desander dump)**, then ask for another dump.',
            good: 'Dumps at LAH-103, reads the dump-fail alarm and does not bypass to get rid of it.', mistakes: ['Bypassing DS-101 during the flow-back.', 'Expecting a shut-in for every dump.'],
            debrief: ['How would you spot a washed-out liner?', 'What would a passing upper isolation do to the dump?', 'How often would you dump on this well?'] } });
    course.push({ id: 'ex10', title: 'Second surge tank T-202', keywords: ['T-202', 'second surge tank', 'XV-202', 'LCV-202', 'route'],
        goal: 'Route the separator dumps between two surge tanks and learn which T-202 trips shut the well in.',
        setup: [BASE, 'In the **Rig-up** card switch **Second surge tank** in (it needs T-201). T-202 starts empty with XV-202 shut.'],
        steps: ['Open the T-202 card. Read **Level**, **Pressure**, **Inlet XV-202**, **Route** and **LCV-202**.', 'Under **Route** select **Both**. Watch **Share of dumps** and both tank pressures.',
            'Select **T-202**: XV-202 opens, then XV-201A and B close (open new, then close old). Run at **×60**.', 'The trainer sets **Scenarios → LCV-202 stuck closed (T-202 transfer)**. Run to LSHH-202 on T-202 only, then again on **Both**.',
            'Reset, route to T-202 and let the trainer set **Scenarios → PCV-203 stuck closed (T-202 back-pressure)**.', OUT('Second surge tank')],
        observe: ['With both open the tank at the lower pressure takes the dumps (check valves): T-202 at the set point may take nothing.', 'On T-202 only, LCV-202 opens at about 70 % level, about 80 minutes later, on the tank pressure (no pump).',
            'LCV-202 stuck, T-202 only: LSHH-202 shuts XV-202 without an ESD, the dumps are blocked and LSHH-102 trips the ESD within a minute. On **Both** the dumps go on into T-201 and nothing trips.',
            'PCV-203 stuck closed: PAH-202 after about 5 minutes; PSHH-202 shuts XV-202 and PCV-204 and trips the ESD about 15 minutes after the fault.'],
        questions: ['Why does the lower-pressure tank take the dumps?', 'Why does LSHH-202 not trip the ESD itself?', 'What protects T-202 from overpressure?'],
        answers: ['Each branch is check-valved into its own gas space: liquid goes only where the header is above the tank pressure.', 'Shutting XV-202 protects the tank; the well is shut in only if the dumps then have nowhere to go.',
            'PCV-203, then PSHH-202 (XV-202 and the blanket PCV-204 shut, then ESD), then PSV-202.'],
        form: DEF, trainer: { duration: '30 minutes.', fault: 'At about 10 minutes on T-202 only: **Scenarios → LCV-202 stuck closed (T-202 transfer)**.',
            good: 'Watches Time to HH, routes to **Both** or T-201 before LSHH-202 and keeps the dumps open.', mistakes: ['Routing to T-202 only and walking away.', 'Shutting every inlet.'],
            debrief: ['When would you run two surge tanks?', 'What does a blocked back-pressure valve look like?', 'Why keep separate gas spaces?'] } });
    scenarios.splice(2, 0, { id: 'FS-3', title: 'Clean-up with sand: the desander upstream of the choke', keywords: ['sand', 'desander', 'proppant', 'flow-back', 'clean-up', 'erosion'],
        intro: ['After a frac or gravel pack the clean-up brings back proppant and sand. DS-101 catches it upstream of the choke, where erosion is worst. Train on [[course#ex9|exercise 9]].'],
        today: [{ list: ['Rig-up: switch **Cyclonic desander (upstream of the choke)** in. Keep the line-up of your clean-up: through V-101, or V-101 out to the burner as in [[fs#FS-1|FS-1]].',
            'Rating: in Dynamic Simulation set **Desander rating (psi)** and **Max shut-in wellhead pressure (psig)**; blank uses 1.2 × WHP ({{3600|pressureG||imp}} here). A rating below it gives ✗ on the DS-101 card: not fit for this well, as it has no relief valve.',
            'Sand (imperial-only inputs): set **Sand rate, liquid (lb/1000 bbl)** and **Sand median size (µm)**, or start ' + DS + ' (LAH-103 about 3.5 hours later).',
            'Dump at LAH-103 (**Dump sand**, about 17 minutes; the well keeps flowing). Rising ΔP: plugged liner or packed accumulator (PDAH-103). Low ΔP: washed-out liner (PDAL-103).',
            'Keep DS-101 in line while sand comes back. At 10 lb per 1,000 bbl on the default spread it cuts the choke erosion rate about 68 times: WARN without it, OK with it.'], ordered: true },
            { h: 'Limits' }, '**Choke erosion** is a steel-equivalent screening figure: it compares cases and does not change the bean or the rate. Sand reaching V-101 is counted, not settled. The steady check leaves out the desander ΔP.'] });
    var A = function (a, x) { return { action: a, args: x }; }, R0 = A('simReset', 'steady'), V2 = A('simView', '2d'), V3 = A('simView', '3d'), RUN = function (sp, s) { return A('simRun', { speed: sp, simSeconds: s }); };
    var add = function (x, id, alt, cap, ops, tgt, view) {
        var s = { id: id, view: view || 'desktop', alt: alt, caption: cap, setup: [R0, V2].concat(ops) };
        if (tgt) s.target = tgt;
        x.shots = (x.shots || []).concat([s]); x.blocks = (x.blocks || []).concat([{ shot: id }]);
    };
    var C = function (n) { return course[n - 1]; }, F = function (id) { return scenarios.filter(function (s) { return s.id === id; })[0]; }, K = '.wtsl-icard', MN = '.wtsl-menu';
    add(C(1), 'view', 'The 2D view at steady flow: HUD and the levels and pressures strip', 'The simulator at steady flow (2D view)', [RUN(10, 60)], '', 'both');
    add(C(2), 'ck101', 'CK-101 card on a 30/64 bean with the choke limit alarm', 'CK-101 on 30/64: capacity below the gas rate', [{ set: { '#wts_bean': '30' } }, RUN(10, 60), A('simCard', 'choke')], K);
    add(C(4), 'scen', 'Scenarios menu open with the fault list', 'The Scenarios menu', [A('simMenu', 'scen')], MN);
    add(C(4), 'v101', 'V-101 card with LCV-102 stuck closed', 'V-101 after LCV-102 sticks closed', [A('simFault', 'oilDumpStuckClosed'), RUN(10, 180), A('simCard', 'separator')], K);
    add(C(4), 'alarms', 'Alarm drawer: alarms and events', 'Alarms and Events', [A('simFault', 'oilDumpStuckClosed'), RUN(10, 300), A('simMenu', 'alarms')], '.wtsl-drawer');
    add(C(5), 'reset', 'Reset menu open', 'The Reset menu', [A('simMenu', 'resetmenu')], MN);
    add(C(5), 'more', 'Phone toolbar with the More menu open', 'The More menu on a phone', [A('simMenu', 'more')], '', 'phone');
    add(C(5), 'viewmenu', '3D view with the View menu (camera views) open', 'The View menu (3D only)', [V3, A('simMenu', 'viewmenu')], MN);
    add(C(5), 'trends', 'Trends of pressures and levels in the 3D view', 'Trends', [V3, RUN(60, 600), A('simMenu', 'trends')]);
    add(C(6), 't301', 'T-301 card after the first batch', 'T-301 and its last batch', [RUN(600, 5400), A('simCard', 'gauge')], K);
    add(C(7), 't201', 'T-201 card: levels, pressure, LCV-201', 'The T-201 surge tank card', [RUN(10, 120), A('simCard', 'surge')], K);
    add(C(8), 'temp3d', '3D view coloured by temperature', 'The 3D view with Colour → Temperature', [V3, A('simMenu', 'colour'), { click: MN + ' [data-v="temperature"]' }]);
    add(C(6), 'events', 'Events tab with the first batch entry', 'The batch entry in Events', [RUN(600, 5400), A('simMenu', 'alarms'), { click: '.wtsl-dtabs [data-v="events"]' }], '.wtsl-drawer');
    add(C(9), 'ds101', 'DS-101 card during sand flow-back', 'DS-101: ΔP, capture, accumulator and Dump sand', [A('simRigup', { desander: 'on' }), A('simFault', 'sandFlowback'), RUN(600, 3600), A('simCard', 'desander')], K);
    add(C(10), 't202', 'T-202 card: level, pressure, inlet, route', 'T-202: route, XV-202 and LCV-202', [A('simRigup', { surge2: 'on' }), RUN(10, 60), A('simCard', 'surge2')], K);
    add(F('FS-1'), 'rigup', 'Rig-up card with V-101 out and its note', 'Rig-up: V-101 out for the burner', [A('simRigup', { separator: 'off' })], '.wtsl-rig');
    add(F('FS-3'), 'rigup', 'Rig-up card with DS-101 in', 'Rig-up with DS-101 in', [A('simRigup', { desander: 'on' })], '.wtsl-rig');
    return { guides: {}, course: course, scenarios: scenarios };
    } });
})();

// === SELF-TEST ===
(function () { /* content is checked by tests/help-course.test.js and tests/help-content.test.js */ })();
