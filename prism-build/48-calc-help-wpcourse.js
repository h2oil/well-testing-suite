// Help: Well performance course (WELL-PERFORMANCE-PLAN §14, WP19); numbers checked by tests/wellperf-course.test.js on the page examples.
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    G.WTS_helpContent = G.WTS_helpContent || { guides: {}, factories: [] };
    G.WTS_helpContent.factories = G.WTS_helpContent.factories || [];
    G.WTS_helpContent.factories.push({ group: 'wpcourse', routes: [], build: function () {
    var OIL = 'Open [[wellperf]] and select **Oil** (vertical oil well, bean 32, test T1).', GAS = 'Open [[wellperf]] and select **Gas** (deviated gas-condensate well, tapered string).';
    var course = [
        { id: 'wp1', course: 'wellperf', title: 'Predict the rate at three beans and compare with a test', keywords: ['bean', 'bean schedule', 'operating point', 'test', 'nodal'],
            goal: 'Predict rate and wellhead pressure at three beans, then check the model against a production test.', setup: [OIL],
            steps: ['⑤ **System**: read the operating point in the KPI strip and on the system plot.', 'Enter **Bean list** 24 32 40 and select **Bean schedule**; open the **Bean schedule** tab.',
            'Drag the bean handle on the system plot to 40 and back to 32: the well re-solves as you drag.', '⑥ **Match**: T1 is {{700|liquidRate}} oil, {{300|liquidRate}} water, THP {{250|pressureG}} on 32/64, gauge {{2500|pressure}} at {{7900|length}} MD. Select **Compare and QC**.',
            'Set **Back-calculate from the test** to **Productivity (p̄r held)** and select **Compare and QC** again.'],
            observe: ['Beans 24, 32, 40: about {{645|liquidRate}}, {{914|liquidRate}} and {{1139|liquidRate}} at THP {{389|pressureG}}, {{320|pressureG}} and {{262|pressureG}}; every bean is critical.',
            'The rate rises 1.77 times from 24 to 40 while the bean area rises 2.78 times.', 'Bean 32 gives {{914|liquidRate}} and THP {{320|pressureG}} against {{1000|liquidRate}} and {{250|pressureG}} measured.',
            'At the gauge Beggs & Brill is {{147|pressure}} low (5.9 %); Duns & Ros ranks first at {{78|pressure}} low but is provisional.', 'T1 implies J {{2.15|productivityIndex}} against {{2|productivityIndex}} entered.'],
            questions: ['Why does the rate not follow the bean area?', 'Is the model optimistic or pessimistic at bean 32, and in which part?', 'Would you switch to the correlation that ranks first?', 'What does the back-calculated J tell you?'],
            answers: ['The inflow and the tubing take more of p̄r as the rate rises: pwf falls from {{2678|pressure}} to {{2430|pressure}}, so the choke sees less pressure.',
            'Pessimistic: the computed gauge pressure is too low and the rate too low. Both the lift and the inflow need a look, one test at a time.',
            'Not on one test: Duns & Ros is provisional (no verified published example) and one gauge cannot rank correlations reliably. Tune instead ([[course#wp3|exercise 3]]).',
            'With the gauge pwf, T1 needs 7 % more productivity than entered; adopt it only if the test was stable.'],
            trainer: { duration: '25–30 minutes.', fault: 'Variant: water cut 50 % before step 2; the trainee explains the lower rates.',
            good: 'Reads rate, THP and regime per bean; compares at the gauge, not only at the wellhead; adopts nothing from one test without a reason.',
            mistakes: ['Expecting the rate to scale with the bean area.', 'Comparing liquid rates with oil rates.', 'Adopting the first-ranked provisional correlation.'],
            debrief: ['Which reading of a test do you trust most, and why?', 'What would a second test at another bean add?', 'When would the choke go sub-critical?'] } },
        { id: 'wp2', course: 'wellperf', title: 'The gas well that loads up: find the string that unloads it', keywords: ['liquid loading', 'Turner', 'tubing size', 'critical rate', 'late life'],
            goal: 'Find where a depleted gas well loads up and pick the tubing that keeps it unloading.', setup: [GAS],
            steps: ['Open the **Liquid loading** tab: the margin at p̄r {{5000|pressure}}.', '② **Reservoir**: set **Average reservoir pressure p̄r** to {{2500|pressure}} (or drag the p̄r handle): late life.',
            'Read the KPI strip and the **Liquid loading** tab: critical rate against depth, worst depth in MD and TVD.', '⑤ **Solve for** **Bean or THP for a target rate**, **Design variable** **Tubing size (catalogue scan)**, **Target rate** 2500; select **Solve the design**.',
            'In the table read the loading margin of each size; select **Use** on the 2-7/8" 6.50 lb/ft row and read the tab again.'],
            observe: ['At {{5000|pressure}} the margin is about +100 %. At {{2500|pressure}}: {{2542|gasRateSmall}} at THP {{1081|pressureG}}; ✗ liquid loading, Turner critical rate {{2.66|gasRate}}, margin −5 %.',
            'The worst depth is {{5000|length}} MD ({{4731|length}} TVD): the bottom of the 3-1/2" top section, not the 2-7/8" below it.',
            'The design names the 1.900" (ID {{1.61|lengthSmall|3}}) as the smallest size that reaches the target; margins run from +215 % (1.900") to −13 % (ID {{2.992|lengthSmall|3}}).',
            'One 2-7/8" string (ID {{2.441|lengthSmall|3}}): {{2598|gasRateSmall}}, margin +38 %, critical rate {{1.88|gasRate}}, worst at the tubing shoe.'],
            questions: ['Why does the wider top section load first?', 'Why does the rate hardly change from one size to the next?', 'Why not take the smallest size the design names?', 'What else would you check before running the new string?'],
            answers: ['The gas velocity is lowest in the widest bore: the critical rate scales with the flow area.',
            'Friction is only about {{31|pressure}} of the drop; gravity ({{1031|pressure}}), the inflow and the choke take the rest, and the bore hardly changes them.',
            'It reaches the target but its erosion ratio (0.58) and friction rise first as the rate climbs; 2-7/8" unloads with margin and loses nothing now.',
            'Erosion at the start-up rate, the margin at a lower p̄r and higher water-gas ratio (a second variable), and whether the shoe stays above the perforations.'],
            trainer: { duration: '25–35 minutes.', fault: 'Variant: at p̄r {{3000|pressure}} raise **Water-gas ratio** from 2 to 20: the margin falls from +21 % to +13 %.',
            good: 'Reads the worst depth in MD and TVD, chooses by loading margin and erosion rather than the first size listed, and states the p̄r at which to re-check.',
            mistakes: ['Checking loading only at the wellhead.', 'Choosing the smallest size without looking at erosion.', 'Forgetting that a tapered string loads in its widest section.'],
            debrief: ['At what p̄r does the 2-7/8" string start to load?', 'What do velocity strings, plunger lift and foam change in this picture?', 'Which test data would confirm loading in the field?'] } },
        { id: 'wp3', course: 'wellperf', title: 'Tune the VLP to a gauge and back-calculate skin', keywords: ['VLP tuning', 'holdup multiplier', 'skin', 'gauge', 'Darcy'],
            goal: 'Make the lift reproduce a gauge, then back-calculate skin with and without the gauge.', setup: [OIL],
            steps: ['⑥ **Match**: select **Compare and QC** and read the Beggs & Brill error at the gauge.', 'In **VLP tuning** leave **Multipliers to fit** on Automatic and select **Tune to the tests**; read m_h and the tuned and untuned traverses against the gauge, then **Apply to the model**.',
            '② **Inflow model** **Darcy radial oil (k·h, skin)**: k {{80|permeability}}, h {{30|length}}, rw {{0.354|length}}, re {{1490|length}}, S 0.',
            '⑥ **Back-calculate from the test** **Skin S (k·h held, Darcy)**, then **Compare and QC**.', 'Clear **Gauge p** of T1 (THP only). Back-calculate skin tuned, then after **Reset to 1 (untuned)**.'],
            observe: ['Untuned: {{147|pressure}} low at the gauge (5.9 %).', 'One test: only m_h is fitted, 1.064 (inside 0.8–1.25); the gauge error goes to zero.',
            'With the gauge: pwf {{2535|pressure}} at the mid-perforations, S +2.8, tuned or not.', 'THP only: tuned S +2.8 again; untuned pwf {{2388|pressure}} and S +6.0.'],
            questions: ['Why does tuning not change the skin when the gauge is used?', 'Why is m_f not fitted?', 'What does an untuned VLP do to skin from THP alone?', 'When would you refuse the tuned multiplier?'],
            answers: ['The pwf comes from the gauge, {{100|length}} above the mid-perforations; the VLP only carries it down that last step.',
            'One test cannot separate holdup from friction (correlation 1.0); m_f needs tests spanning 2:1 in rate (rule D10).',
            'It puts pwf {{147|pressure}} too low, so the inflow looks worse: S +6.0 instead of +2.8, a stimulation candidate that is not.',
            'At a bound (TUNE_AT_BOUND), on an unstable test, or when the tuned correlation is provisional and untested elsewhere.'],
            trainer: { duration: '30–40 minutes.', fault: 'Variant: gauge {{2800|pressure}} in T1; m_h stops at its 1.25 bound (TUNE_AT_BOUND) and the trainee must not apply it.',
            good: 'Tunes before inverting the inflow, applies the multiplier knowingly and explains why the gauge-based skin does not move.',
            mistakes: ['Back-calculating skin from THP with an untuned VLP.', 'Fitting m_f to one test.', 'Treating Darcy skin from a provisional model as final.'],
            debrief: ['What does a second test at another rate add?', 'How would you confirm skin independently (build-up)?', 'Which number goes into the report Notes?'] } }
    ];
    return { guides: {}, course: course };
    } });
})();

// === SELF-TEST ===
(function () { /* content is checked by tests/wellperf-course.test.js and tests/help-content.test.js */ })();
