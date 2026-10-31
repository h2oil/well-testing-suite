// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 helper module — Chemical Injection background pop-ups (cheminj info)
//
// PURPOSE
//   The ⓘ buttons of the Chemical Injection page (route `cheminj`,
//   prism-build/49-calc-cheminj.js) open an accessible modal dialog with the
//   background of a topic: what the chemistry is and how it works, when to
//   use it in a well test (and when not), where to inject and why, the dose
//   basis and planning range, the key cautions and a "Standards and
//   references" list. Doses, point rankings, compatibility rules, product
//   cautions, seal screening and the design-basis defaults are read from
//   WTS_chemlib (prism-build/40-calc-chemlib.js) when a dialog opens, so the
//   text never disagrees with the calculator; every number with a unit goes
//   through WTS_units, so Metric mode shows converted values.
//
//   Like 40-calc-chemlib.js this is a helper module: it deliberately does NOT
//   add a page to window.WTS_calcRegistry, so it has no sidebar button or tile.
//   Generic chemistry names only; no company, brand, product or web address.
//
// DIALOG
//   Mounted inside #cj_root (navigation removes it with the page) as
//   .cj-dlg-ov.rp-skip[data-rp-nosnap]: role="dialog", aria-modal="true",
//   labelled by its title and described by its lead paragraph. Focus moves into
//   the dialog and returns to the button that opened it; Esc, the × and Close
//   buttons and a backdrop click close it; Tab stays inside. It holds no form
//   control, so autosave, the report model and the calculation never see it,
//   and opening it never recalculates. No timers and no document listeners:
//   the keys are handled on the overlay, which holds the focus.
//
// PUBLIC API (window.WTS_cheminjInfo)
//   topics[]                       topic keys of the "Background and standards" row, in order
//   keys()                         every topic key (the row plus 'water' and 'custom')
//   title(key)                     topic title ('' for an unknown key)
//   topicFor(chemKey)              topic key of a chemical's family (null for an unknown key)
//   content(key, opts?)            {ok, key, family, chem, title, lead, sections[{id, h, html}], refs[], disclaimer}
//                                  | {ok:false, error}. key 'chem' = the family of opts.chem (its own
//                                  title, lead and two family sections, then the topic sections).
//                                  opts {chem, point, pump} add a "Your selection" section to
//                                  'points' and 'pumps'. Section html is escaped markup.
//   button(key, aria, n?, sec?)    ⓘ icon button markup (rp-skip, data-rp-nosnap, no id)
//   strip()                        the "Background and standards" row of topic buttons
//   css()                          the stylesheet, scoped to #cj_root
//   open(key, opts, opener, mount) opens the dialog (opts.section scrolls to that section) → dialog element | null
//   close()                        closes it; focus goes back to the opener → true when one was open
//   isOpen()
//   refs                           the reference texts, keyed
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;

    function _lib() { return G.WTS_chemlib || null; }
    function _fin(x) { return typeof x === 'number' && isFinite(x); }
    function _has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
    function _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
    }

    // ── Numbers (display system; decimal comma through WTS_fmtNum) ────
    function _isM() { var U = G.WTS_units; return !!(U && typeof U.getSystem === 'function' && U.getSystem() === 'metric'); }
    function _nf(v, d, dmin) {
        if (!_fin(v)) return '–';
        var mx = d == null ? 2 : d, mn = dmin == null ? 0 : Math.min(dmin, mx);
        try {
            return (typeof G.WTS_fmtNum === 'function') ? G.WTS_fmtNum(v, mn, mx)
                : Number(v).toLocaleString('en-GB', { minimumFractionDigits: mn, maximumFractionDigits: mx });
        } catch (e) { return Number(v).toFixed(mx); }
    }
    function _hasCat(cat) { var U = G.WTS_units; return !!(U && typeof U.format === 'function' && U.CATEGORIES && U.CATEGORIES[cat]); }
    // value with its unit in the display system: imperial label imp with d decimals, Metric with dm
    function _q(v, cat, d, imp, dm) {
        if (!_fin(v)) return '–';
        if (_isM() && _hasCat(cat)) {
            var f = G.WTS_units.format(v, cat);
            return _nf(f.value, dm == null ? d : dm) + (f.label ? ' ' + f.label : '');
        }
        return _nf(v, d) + (imp ? ' ' + imp : '');
    }
    function _dT(v) { return _q(v, 'tempDelta', 0, '°F', 1); }          // temperature difference
    function _T(v) { return _q(v, 'temperature', 0, '°F', 0); }         // temperature
    function _dP(v) { return _q(v, 'pressure', 0, 'psi', 0); }          // pressure difference
    function _n(v) { return _nf(v, v >= 100 ? 0 : v >= 10 ? 1 : 2); }  // plain number, about 3 figures
    // Library prose quoted as is; in Metric a pressure written in it ("about 1000 psi") is converted.
    function _lt(s) {
        s = String(s == null ? '' : s);
        if (!_isM()) return s;
        return s.replace(/(\d[\d,]*(?:\.\d+)?)\s*psi[ag]?\b/g, function (m, x) { return _dP(Number(x.replace(/,/g, ''))); });
    }

    // ── Markup helpers: text is escaped after its {tokens} are filled ──
    function tx(s, v) {
        return _esc(String(s).replace(/\{(\w+)\}/g, function (m, k) { return (v && v[k] != null) ? String(v[k]) : m; }));
    }
    function P(html) { return '<p>' + html + '</p>'; }
    function UL(items) {
        var it = (items || []).filter(function (x) { return !!x; });
        return it.length ? '<ul>' + it.map(function (x) { return x.indexOf('<li') === 0 ? x : '<li>' + x + '</li>'; }).join('') + '</ul>' : '';
    }
    function B(s) { return '<b>' + _esc(s) + '</b>'; }
    function S(id, h, html) { return { id: id, h: h, html: html }; }

    // ── Library-driven fragments ─────────────────────────────────────
    var LEVEL_TXT = { R: '✓ Recommended', A: '✓ Allowed', N: '⚠ Not recommended' };
    var TAG_TXT = {
        organic: 'organic chemicals', oxidiser: 'oxidisers', triazine: 'triazine', amine: 'amines', nitrite: 'nitrite',
        aldehyde: 'aldehydes', bisulfite: 'bisulfite', acidic_si: 'acidic scale inhibitors', cationic: 'cationic products',
        anionic: 'anionic products', methanol: 'methanol', scale_inhibitor: 'scale inhibitors',
        corrosion_inhibitor: 'corrosion inhibitors', demulsifier: 'demulsifiers', antifoam: 'antifoams',
        silicone: 'silicone antifoam', glyoxal: 'glyoxal', aqueous_scavenger: 'aqueous scavengers'
    };
    var CTX_TXT = {
        hc_tank: 'in a hydrocarbon tank or vapour space', sepgas_no_ko: 'at the separator gas outlet without a knock-out',
        ca_water: 'in produced water with calcium or bicarbonate', sale_crude: 'in crude for sale',
        carbon_steel: 'with carbon-steel wetted parts'
    };
    var MAT_TXT = { 'FKM std': 'standard FKM', 'FKM peroxide': 'peroxide-cured FKM' };
    var GRADE = [['A', 'good'], ['A-B', 'good to fair'], ['B', 'fair'], ['B-C', 'fair to poor'], ['C', 'poor']];
    var LINE_TXT = {
        dh: 'tubing pressure at the injection depth', wh: 'the higher of the shut-in and flowing wellhead pressures',
        ck: 'the pressure downstream of the choke', sep: 'the separator pressure',
        bpv: 'the flare-line pressure downstream of the back-pressure valve', atm: 'atmospheric pressure'
    };
    var BACK_TXT = { sithp: 'rated for the shut-in tubing head pressure', psvsep: 'rated for the separator relief-valve set pressure', none: '' };
    var SET_TXT = {
        spm: 'strokes per minute on the drive-gas regulator',
        stroke_speed: '% stroke × % speed',
        air: 'the drive-air pressure, verified by a drawdown check',
        cycles: 'cycles per minute (transfer duty)',
        batch: 'batch volume'
    };

    function _note(si) { return (!si || /^(Recommended|Allowed) point\.$/.test(si.note)) ? '' : si.note; }   // the generic notes add nothing
    function _cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
    function _tags(list) { return (list || []).map(function (t) { return TAG_TXT[t] || String(t).replace(/_/g, ' '); }).join(' or '); }
    function _chemsOf(L, fams) { return L.chemicals.filter(function (c) { return fams.indexOf(c.family) !== -1; }); }
    function _famsOf(L, group, kind) {
        return L.families.filter(function (f) { return f.group === group && (!kind || f.kind === kind); }).map(function (f) { return f.key; });
    }
    function _ptShort(L, k) { var p = L.point(k); return p ? p.short : k; }

    // One dose line per chemical; Metric uses the basis twin (L/kg, L/10⁶ Sm³) exactly like the page preset.
    function _doseBasis(L, c) {
        var b = L.bases[c.basis], f = 1;
        if (_isM() && b && b.twin && (c.basis === 'pt_mmscf' || c.basis === 'gal_mmscf' || c.basis === 'gal_lb_h2s')) { f = b.factor; b = L.bases[b.twin]; }
        return { b: b, f: f };
    }
    function _doseItem(L, c) {
        var db = _doseBasis(L, c), u = db.b ? db.b.unit : '', lab = db.b ? db.b.label : '';
        var v = function (x) { return _fin(x) ? _n(x * db.f) : '–'; }, h;
        if (c.kind === 'thi' && c.thi) {
            h = B(c.name) + tx(': dose calculated from the hydrate design (rich wt % in the water). Lean strength {l} wt % as supplied (range {l0} to {l1} wt %); warning above {w} wt % in the water, practical limit {mx} wt %.',
                { l: _n(c.leanDef), l0: _n(c.leanMin), l1: _n(c.leanMax), w: _n(c.thi.warnPct), mx: _n(c.thi.maxPct) });
        } else if (c.kind === 'custom') {
            h = B(c.name) + tx(': enter the dose basis, dose, SG, viscosity and water content from the data sheet.');
        } else if (c.dose == null) {
            h = B(c.name) + tx(': calculated from stoichiometry ÷ utilisation; planning range {a} to {b} {u} ({lab}).', { a: v(c.doseMin), b: v(c.doseMax), u: u, lab: lab });
        } else {
            h = B(c.name) + tx(': {d} {u} (range {a} to {b}); basis: {lab}.', { d: v(c.dose), a: v(c.doseMin), b: v(c.doseMax), u: u, lab: lab });
        }
        return '<li data-chem="' + _esc(c.key) + '">' + h + '</li>';
    }
    function _doseList(L, chems) { return UL(chems.map(function (c) { return _doseItem(L, c); })); }
    function _suitLines(L, fams) {
        return UL(fams.map(function (fk) {
            var f = L.family(fk), r = [], a = [], n = [];
            if (!f) return '';
            L.points.forEach(function (p) {
                var s = f.suit[p.key];
                if (s === 'R') r.push(p.short); else if (s === 'A') a.push(p.short); else if (s === 'N') n.push(p.short);
            });
            return B(f.label) + tx(': recommended — {r}; allowed — {a}; not recommended — {n}.',
                { r: r.join(', ') || 'none', a: a.join(', ') || 'none', n: n.join(', ') || 'none' });
        }));
    }
    function _compatList(L, chems) {
        var seen = {}, out = [];
        (L.compat || []).forEach(function (r) {
            var hit = chems.some(function (c) {
                return (c.incompat || []).some(function (t) { return t !== 'organic' && (r.a.indexOf(t) !== -1 || (r.b && r.b.indexOf(t) !== -1)); });
            });
            if (!hit || seen[r.key]) return;
            seen[r.key] = 1;
            out.push(tx('{s} {a}{b}: {t}', {
                s: r.level === 'bad' ? '✗' : '⚠', a: _cap(_tags(r.a)),
                b: r.b ? ' with ' + _tags(r.b) : (CTX_TXT[r.ctx] ? ' ' + CTX_TXT[r.ctx] : ''), t: r.text
            }));
        });
        return out;
    }
    function _compatSec(L, chems) {
        var c = _compatList(L, chems);
        return c.length ? S('compat', 'Compatibility checks the page applies', UL(c)) : null;
    }
    function _cautionList(L, chems) {
        return UL(chems.filter(function (c) { return c.cautions && c.kind !== 'custom'; }).map(function (c) { return B(c.short || c.name) + tx(': {t}', { t: _lt(c.cautions) }); }));
    }
    function _sealTxt(row) {
        if (!row) return '';
        var L = _lib(), mats = (L && L.elastomer && L.elastomer.materials) || [], parts = [];
        GRADE.forEach(function (g) {
            var m = mats.filter(function (k) { return row[k] === g[0]; }).map(function (k) { return MAT_TXT[k] || k; });
            if (m.length) parts.push(g[1] + ': ' + m.join(', '));
        });
        var lab = String(row.label || '');
        if (/^[A-Z][a-z]/.test(lab)) lab = lab.charAt(0).toLowerCase() + lab.slice(1);
        return parts.length ? tx('Seal screening for {r} — {p}.', { r: lab, p: parts.join('; ') }) : '';
    }

    // ── References (number, title or scope; years only where certain) ──
    var REF = {
        iso15156: 'ISO 15156 (also published as NACE MR0175/ISO 15156) — Petroleum and natural gas industries: materials for use in H2S-containing environments in oil and gas production.',
        rp55: 'API RP 55 — Recommended Practice for Oil and Gas Producing and Gas Processing Plant Operations Involving Hydrogen Sulfide.',
        rp49: 'API RP 49 — Recommended Practice for Drilling and Well Servicing Operations Involving Hydrogen Sulfide.',
        rp14c: 'API RP 14C — analysis, design, installation and testing of safety systems for offshore production facilities (safety analysis of process components, including pumps and injection lines).',
        iso10418: 'ISO 10418 — Petroleum and natural gas industries: offshore production installations, process safety systems (safety analysis).',
        std675: 'API Std 675 — Positive Displacement Pumps: Controlled Volume for Petroleum, Chemical, and Gas Industry Services.',
        std674: 'API Std 674 — Positive Displacement Pumps: Reciprocating.',
        rp14e: 'API RP 14E — Recommended Practice for Design and Installation of Offshore Production Platform Piping Systems (erosional velocity).',
        std520: 'API Std 520 — Sizing, Selection, and Installation of Pressure-relieving Devices (Part I sizing and selection, Part II installation).',
        std521: 'API Std 521 — Pressure-relieving and Depressuring Systems.',
        rp500: 'API RP 500 and API RP 505 — classification of locations for electrical installations at petroleum facilities (Class I, Division and Zone systems).',
        spec6a: 'API Spec 6A — Specification for Wellhead and Tree Equipment (pressure ratings of flowheads and connections).',
        gpsa: 'GPSA Engineering Data Book — dehydration section (hydrate formation and hydrate inhibition with methanol and glycols).',
        gpsaTreat: 'GPSA Engineering Data Book — hydrocarbon treating section (H2S removal).',
        sloan: 'Sloan, E.D. and Koh, C.A. — Clathrate Hydrates of Natural Gases, 3rd edition.',
        carroll: 'Carroll, J. — Natural Gas Hydrates: A Guide for Engineers.',
        hammer: 'Hammerschmidt, E.G. (1934) — Formation of gas hydrates in natural gas transmission lines (hydrate depression equation).',
        nb: 'Nielsen, R.B. and Bucklin, R.W. (1983) — Why not use methanol for hydrate control? (methanol depression equation).',
        tm: 'Towler, B.F. and Mokhatab, S. (2005) — Quickly estimate hydrate formation conditions in natural gases (gas-gravity hydrate correlation used by the page).',
        kelland: 'Kelland, M.A. — Production Chemicals for the Oil and Gas Industry, 2nd edition.',
        kelland06: 'Kelland, M.A. (2006) — History of the development of low dosage hydrate inhibitors (review).',
        eh40: 'UK Health and Safety Executive — EH40/2005 Workplace exposure limits (hydrogen sulfide, methanol). Use the national limits that apply at the site.',
        niosh: 'NIOSH Pocket Guide to Chemical Hazards — hydrogen sulfide and methanol (IDLH values and recommended exposure limits).',
        rp45: 'API RP 45 — Recommended Practice for Analysis of Oilfield Waters.',
        mpms10: 'API MPMS Chapter 10 — Sediment and Water (determination of water and sediment in crude oil).',
        d97: 'ASTM D97 — Standard Test Method for Pour Point of Petroleum Products.',
        sds: 'The safety data sheet (SDS) and technical data sheet of the product.'
    };
    var DISCLAIMER = 'Planning guidance only — follow the product data sheet and site procedures.';

    // ── Topics ───────────────────────────────────────────────────────
    var TOPICS = {};

    TOPICS.hydrate = {
        title: 'Hydrate inhibition: methanol and glycols', chip: 'Hydrate inhibition',
        refs: ['gpsa', 'sloan', 'carroll', 'hammer', 'nb', 'tm', 'eh40', 'rp500'],
        lead: function () {
            return tx('Gas hydrates are ice-like solids of water and light gas molecules (methane, ethane, propane, CO2, H2S) that form at high pressure and low temperature wherever liquid water is present. In a well test they can plug the choke, the flowhead, instrument lines and the heater coil within minutes.');
        },
        build: function (L) {
            var D = L.defaults, fams = _famsOf(L, 'hydrate', 'thi'), chems = _chemsOf(L, fams);
            var meoh = L.find('meoh'), meg = L.find('meg');
            return [
                S('what', 'What it is and how it works',
                    P(tx('A thermodynamic inhibitor dissolves in the water and moves the hydrate curve to a lower temperature, as antifreeze lowers the freezing point. The shift depends on the inhibitor concentration in the water phase (the rich concentration), so doses are large — tens of percent of the water — plus whatever the gas and condensate carry away.')) +
                    P(tx('Methanol is cheap, light and effective at low temperature, but a large share partitions into the gas and condensate. MEG stays almost entirely in the water and is far less flammable, but it is viscous when cold and needs a higher concentration for the same depression. DEG and TEG are rarely injected for hydrate control.'))),
                S('when', 'When to use it in a well test',
                    P(B('Use it')) + UL([
                        tx('On gas and gas-condensate wells with free or condensed water, whenever a point of the spread falls below the hydrate temperature plus the design margin: most often the choke outlet (Joule–Thomson cooling), and above all during start-up from a cold tree, at low rates, in cold weather and in a shut-in tree.'),
                        tx('From before the well is opened, through clean-up, until the heater keeps the choke outlet clear of the hydrate region with margin.'),
                        tx('Ahead of a planned shut-in, so the water trapped in the tree and flowhead is inhibited.')
                    ]) + P(B('Not needed, or not the best choice')) + UL([
                        tx('When every node — flowing, shut-in and start-up — stays warmer than the hydrate temperature plus the margin, for example a hot oil well with little gas.'),
                        tx('When the water rate is high: thermodynamic doses scale with the water, so a low-dose inhibitor, heat or a different choke strategy may be more practical.')
                    ])),
                S('where', 'Where to inject and why',
                    UL([
                        tx('Upstream of the choke (flowhead or upstream data header) is the recommended point: the inhibitor must be mixed into the water before the gas expands and cools across the choke, which is normally the coldest point of the spread.'),
                        tx('Downhole, through a chemical injection valve or capillary, when the wellbore itself crosses the hydrate region (cold seabed or ground, long shut-ins).'),
                        tx('Downstream of the choke does not protect the choke body and bean, and the separator inlet is too late. Gas re-expanded at the back-pressure valve can need a second point at the separator gas outlet.')
                    ]) + P(tx('Point ranking used by the page:')) + _suitLines(L, fams)),
                S('dose', 'Dose basis and typical range',
                    P(tx('The page finds the required depression (hydrate temperature plus margin, minus the coldest temperature) and the rich concentration that gives it — the larger of the Hammerschmidt and Nielsen–Bucklin results, Hammerschmidt only for DEG and TEG. It then adds the free, condensed and chemical water to treat and the methanol lost to the gas and condensate.')) +
                    UL([
                        tx('Design margin {m} with the gas-gravity hydrate correlation; {mm} allowed with a lab hydrate temperature.', { m: _dT(D.marginF), mm: _dT(D.marginMinF) }),
                        tx('Joule–Thomson cooling × {f} for design (editable from {f0} to {f1}).', { f: _nf(D.fJT, 2, 2), f0: _nf(D.fJTMin, 2, 2), f1: _nf(D.fJTMax, 2, 2) }),
                        tx('Sour gas: an adder of {s} per mol % H2S above {s0} mol %, and for CO2 above {c} mol %; above {sx} mol % H2S the correlation is refused unless a lab hydrate temperature is entered.',
                            { s: _dT(D.sourPerMolF), s0: _nf(D.sourNoAdderMolPct, 1), c: _nf(D.co2AdderMolPct, 0), sx: _nf(D.sourMaxMolPct, 0) }),
                        tx('Pump peak factor {p} × the design rate, for start-up.', { p: _nf(D.peakThi, 2, 1) })
                    ]) + P(tx('Products in the library:')) + _doseList(L, chems)),
                S('cautions', 'Key cautions',
                    UL([
                        meoh ? tx('Methanol: flash point {f}; it burns with a near-invisible flame and is toxic by inhalation, skin contact and ingestion — a small amount swallowed can cause blindness or death. Bond and ground during transfer, keep ignition sources away, shade the tank and keep a flooded pump suction, and treat methanol-laden separator water, tanks and pits as flammable.', { f: _T(meoh.flashF) }) : '',
                        tx('Exposure: methanol carries a skin notation; for example the UK workplace exposure limit is 200 ppm (8-hour) and 250 ppm (15-minute). Use the limit that applies at the site.'),
                        tx('Brine and scale: with high-salinity water methanol can precipitate salt, and some scale inhibitors drop out of methanol-rich water — test compatibility (MEG is milder).'),
                        meg ? tx('MEG: viscous when cold, so size the tubing for the minimum temperature; pure MEG freezes at about {fz}, so a blend is used in cold weather (library default {l} wt %); toxic if swallowed.', { fz: _T(meg.freezeF), l: _n(meg.leanDef) }) : '',
                        L.elastomer && L.elastomer.note ? tx('{n}', { n: _lt(L.elastomer.note) }) : '',
                        tx('Hydrate plugs: treat a suspected plug as trapped pressure — depressurise both sides equally, never heat the middle of a plug, and keep people out of the line of fire.'),
                        tx('Methanol carried into crude or condensate for sale can exceed the buyer\'s limit.')
                    ]) + P(tx('Product cautions from the chemical library:')) + _cautionList(L, chems)),
                _compatSec(L, chems)
            ];
        }
    };

    TOPICS.ldhi = {
        title: 'Low-dose hydrate inhibitors: KHI and AA', chip: 'Low-dose hydrate inhibitors',
        refs: ['kelland', 'kelland06', 'sloan', 'gpsa'],
        lead: function (L) {
            var cs = _chemsOf(L, _famsOf(L, 'hydrate', 'ldhi')), lo = Infinity, hi = -Infinity;
            cs.forEach(function (c) { if (_fin(c.doseMin)) lo = Math.min(lo, c.doseMin); if (_fin(c.doseMax)) hi = Math.max(hi, c.doseMax); });
            return tx('Low-dose hydrate inhibitors work at about {lo} to {hi} vol % of the water instead of the tens of percent a thermodynamic inhibitor needs, but they are formulation-specific and must be qualified for the fluids.', { lo: _n(lo), hi: _n(hi) });
        },
        build: function (L) {
            var fams = _famsOf(L, 'hydrate', 'ldhi'), chems = _chemsOf(L, fams);
            var khi = L.find('khi'), aa = L.find('aa'), kl = khi && khi.ldhi, al = aa && aa.ldhi;
            return [
                S('what', 'What it is and how it works',
                    P(tx('Kinetic hydrate inhibitors (KHI) are water-soluble polymers that delay hydrate nucleation and growth for a hold time. They do not move the hydrate curve, so protection ends when the hold time runs out or the subcooling is too high.')) +
                    P(tx('Anti-agglomerants (AA) are surfactants that let small hydrate particles form but keep them dispersed in the liquid hydrocarbon, so they flow as a slurry instead of sticking and building a plug.'))),
                S('when', 'When to use it in a well test',
                    P(B('Use it')) + UL([
                        kl ? tx('KHI: when the subcooling (hydrate temperature minus the actual temperature) stays within the product limit in every case — flowing, shut-in and start-up — and the hold time covers the residence time plus any planned shut-in. Library planning screen: up to about {a} subcooling for a standard KHI, up to about {b} for an advanced KHI with qualification.', { a: _dT(kl.subMaxF), b: _dT(kl.subAdvF) }) : '',
                        al ? tx('AA: only with a liquid hydrocarbon phase and a water cut of {w} % or less.', { w: _n(al.maxWaterCutPct) }) : '',
                        tx('When high water rates make the volume, storage or logistics of a thermodynamic inhibitor impractical.')
                    ]) + P(B('Not the right choice')) + UL([
                        tx('Short tests that may be shut in unexpectedly: a thermodynamic inhibitor is the default.'),
                        tx('Subcooling above the product limit, which is common through the choke at start-up: use a thermodynamic inhibitor or heat.'),
                        tx('Dry gas with no condensate, or a water cut above the limit (AA).'),
                        tx('Any product not yet qualified for the fluids.')
                    ]) + P(tx('The page doses these products on vol % of the water phase; read the subcooling at each node from the spread hydrate check.'))),
                S('where', 'Where to inject and why',
                    UL([
                        tx('Upstream of the choke (recommended) or downhole, so the product is mixed into the water before it cools.'),
                        tx('Check the KHI cloud point at the hottest point (downhole): some polymers come out of solution when hot.'),
                        tx('The separator inlet is too late: the choke outlet is already the coldest point.')
                    ]) + P(tx('Point ranking used by the page:')) + _suitLines(L, fams)),
                S('dose', 'Dose basis and typical range',
                    P(tx('Product as supplied, on vol % of the water phase (free plus condensed water):')) + _doseList(L, chems)),
                S('cautions', 'Key cautions',
                    UL([
                        tx('Qualify by rocking-cell or autoclave test on representative fluids before the test, including the shut-in and restart case.'),
                        tx('KHI: once the hold time ends, hydrates can still form; plan the shut-in duration and the restart.'),
                        tx('AA: can stabilise emulsions and slow oil–water separation; check aquatic toxicity and the discharge rules.'),
                        tx('Carrier solvents are often flammable: check the product flash point.'),
                        tx('Check compatibility with the corrosion inhibitor and the other chemicals by test.'),
                        khi ? _sealTxt(L.elastomerRow('khi')) : ''
                    ]) + P(tx('Product cautions from the chemical library:')) + _cautionList(L, chems)),
                _compatSec(L, chems)
            ];
        }
    };

    TOPICS.h2s = {
        title: 'H2S scavenging', chip: 'H2S scavenging',
        refs: ['rp55', 'rp49', 'iso15156', 'eh40', 'niosh', 'gpsaTreat', 'kelland'],
        lead: function () {
            return tx('H2S scavengers react irreversibly with hydrogen sulfide to lower its concentration in the gas, oil or water leaving the spread. They do not make a sour well sweet for materials or safety purposes.');
        },
        build: function (L) {
            var fams = _famsOf(L, 'h2s'), chems = _chemsOf(L, fams);
            var eta = L.points.filter(function (p) { return _fin(p.etaScav); }).map(function (p) { return tx('{p} {e} %', { p: p.short, e: _nf(p.etaScav * 100, 0) }); });
            var own = chems.filter(function (c) { return c.stoich && _fin(c.effDef); }).map(function (c) { return tx('{c} {e} %', { c: c.short, e: _nf(c.effDef * 100, 0) }); });
            return [
                S('what', 'What it is and how it works',
                    P(tx('Aqueous triazines (MEA- or MMA-triazine) react with H2S in the gas and water to form dithiazine and amine; glyoxal and formaldehyde-releaser blends are aldehyde alternatives. Oil-soluble amine–aldehyde and zinc carboxylate products treat H2S dissolved in crude and condensate. Oxidisers (sodium nitrite, hydrogen peroxide) treat water only.')) +
                    P(tx('The reaction needs contact: droplet size, turbulence and time decide how much of the product is used (the utilisation).'))),
                S('when', 'When to use it in a well test',
                    P(B('Use it')) + UL([
                        tx('To keep H2S at the flare, vents, tank vapour space and sample points, and in gas or oil sent to a buyer, below the target.'),
                        tx('When the mass of H2S per day is small enough for a practical chemical volume: the page converts the gas rate and H2S content into the mass to remove.')
                    ]) + P(B('Not a substitute for')) + UL([
                        tx('Sour-service materials, H2S detection, breathing apparatus or the radius-of-exposure assessment: these all use the untreated H2S.'),
                        tx('H2S measurement: take H2S and PVT samples upstream of the scavenger, or with it off.'),
                        tx('A treating or flaring strategy when the H2S load is high: chemical volume, spent solids and logistics grow quickly.')
                    ])),
                S('where', 'Where to inject and why',
                    UL([
                        tx('Upstream of the choke (recommended) for the longest contact time and the mixing energy of the choke; downstream of the choke is allowed; at the separator inlet the contact time is short.'),
                        tx('At the separator gas outlet an aqueous scavenger needs a knock-out or contactor downstream, or liquid carries to the flare.'),
                        tx('Oil-phase products go into the separator oil outlet or the tank; oxidisers only into the separator water outlet or a vented, non-hydrocarbon tank.')
                    ]) + P(tx('Point ranking used by the page:')) + _suitLines(L, fams)),
                S('dose', 'Dose basis and typical range',
                    P(tx('Gas-phase scavenger lines are sized as product per mass of H2S removed = stoichiometry ÷ utilisation, from the gas rate, the H2S content and the outlet target you enter.')) +
                    (eta.length ? P(tx('Utilisation the page assumes by point: {e}', { e: eta.join(', ') }) + (own.length ? tx('; product values override it ({o}).', { o: own.join(', ') }) : tx('.'))) : '') +
                    P(tx('Products in the library (product as supplied):')) + _doseList(L, chems)),
                S('cautions', 'Key cautions',
                    UL([
                        tx('H2S is very toxic and heavier than air, so it collects in cellars, tanks and low points. It deadens the sense of smell from about 100 ppm, 100 ppm is immediately dangerous to life or health, and at several hundred ppm collapse can follow within minutes.'),
                        tx('Exposure limits are low and set nationally — for example the UK workplace exposure limit is 5 ppm (8-hour) and 10 ppm (15-minute). Use the limit that applies at the site, fixed and personal gas detectors, and breathing apparatus as set out in the H2S contingency plan.'),
                        tx('H2S is flammable from about 4 % in air; burning it produces toxic sulfur dioxide.'),
                        tx('Sour service: if the untreated H2S partial pressure is at or above {pp}, equipment wetted by the fluid must meet ISO 15156 / NACE MR0175. Scavenging does not change the materials basis or the radius of exposure.', { pp: _isM() ? '0.3 kPa' : '0.05 psia' }),
                        tx('Spent scavenger: triazine forms dithiazine solids when over-spent or at low velocity, raises the pH (calcium carbonate scale with calcium-rich water) and adds water to the hydrate load; plan for solids at the separator and in the water.'),
                        tx('Incompatibilities: never mix oxidisers with organic chemicals, or nitrite with amines (nitrosamines); keep triazine apart from aldehydes and acidic scale inhibitors, and check it against the corrosion inhibitor — use separate lines and quills.'),
                        tx('Do not drive pneumatic or air-driven pumps with sour produced gas.')
                    ]) + P(tx('Product cautions from the chemical library:')) + _cautionList(L, chems)),
                _compatSec(L, chems)
            ];
        }
    };

    TOPICS.corrosion = {
        title: 'Corrosion inhibition', chip: 'Corrosion inhibition',
        refs: ['iso15156', 'rp14e', 'kelland'],
        lead: function () {
            return tx('Produced water with CO2, H2S or oxygen corrodes carbon steel; a corrosion inhibitor forms a thin adsorbed film on the metal that slows the attack.');
        },
        build: function (L) {
            var fams = _famsOf(L, 'corrosion'), chems = _chemsOf(L, fams);
            return [
                S('what', 'What it is and how it works',
                    P(tx('Film formers (imidazolines, fatty amines, quaternary ammonium compounds) are surface-active: the polar head adsorbs on the steel and the hydrocarbon tail repels water. Oil-soluble, water-soluble and gas-well (atomised) grades suit different phases. The film is kept up by continuous injection or renewed by batch treatments.'))),
                S('when', 'When to use it in a well test',
                    P(B('Use it')) + UL([
                        tx('Longer or extended well tests with produced water and CO2 or H2S through carbon-steel tubing, temporary pipework or the heater coil.'),
                        tx('Flowback of spent acid after a stimulation, or with an acidic chemical in the system (for example glyoxal scavenger).')
                    ]) + P(B('Not needed, or not enough')) + UL([
                        tx('Short tests through corrosion-resistant equipment with little water.'),
                        tx('It never replaces sour-service materials, and it does not protect against erosion: sand and high velocity strip the film.')
                    ])),
                S('where', 'Where to inject and why',
                    UL([
                        tx('Upstream of the equipment it protects: downhole for the tubing, upstream of the choke for the surface spread. Injected after the separator it protects only what is downstream.'),
                        tx('Gas-well inhibitors are atomised into the gas at the flowhead so the mist reaches the pipe wall.')
                    ]) + P(tx('Point ranking used by the page:')) + _suitLines(L, fams)),
                S('dose', 'Dose basis and typical range',
                    P(tx('Product as supplied, on the phase named in the dose basis:')) + _doseList(L, chems) +
                    P(tx('Overdosing adds no protection and causes emulsions and foam; on longer tests confirm the rate with coupons, probes or iron counts.'))),
                S('cautions', 'Key cautions',
                    UL([
                        tx('Cationic corrosion inhibitors and anionic scale inhibitors precipitate when mixed neat: use separate quills several pipe diameters apart.'),
                        tx('Most oil-soluble products are in flammable aromatic solvents: check the flash point and the seals.'),
                        _sealTxt(L.elastomerRow('ci_film_liq')),
                        tx('Keep the flow within the erosional velocity (API RP 14E); do not rely on an inhibitor against erosion.'),
                        tx('Inhibitors do not replace sour-service materials (ISO 15156 / NACE MR0175).')
                    ]) + P(tx('Product cautions from the chemical library:')) + _cautionList(L, chems)),
                _compatSec(L, chems)
            ];
        }
    };

    TOPICS.scale = {
        title: 'Scale inhibition', chip: 'Scale inhibition',
        refs: ['rp45', 'kelland'],
        lead: function () {
            return tx('Scale is mineral deposit from produced water — mainly calcium carbonate where the pressure drops and CO2 leaves the water, and barium, strontium or calcium sulfate where incompatible waters mix.');
        },
        build: function (L) {
            var fams = _famsOf(L, 'scale'), chems = _chemsOf(L, fams);
            return [
                S('what', 'What it is and how it works',
                    P(tx('Threshold inhibitors (phosphonates and polymers) adsorb on growing crystal nuclei and stop them growing at a few ppm, far below the stoichiometric amount. The dose must stay above the minimum inhibitor concentration (MIC) for the water and the temperature.'))),
                S('when', 'When to use it in a well test',
                    P(B('Use it')) + UL([
                        tx('When the water analysis shows a scaling tendency (saturation index above zero) at the spread conditions, especially across the choke where the pressure drops.'),
                        tx('During clean-up, when completion or kill brine mixes with formation water, and when a triazine scavenger raises the pH.')
                    ]) + P(B('Not needed')) + UL([
                        tx('Dry gas with no produced water, or water that stays undersaturated across the spread.')
                    ])),
                S('where', 'Where to inject and why',
                    UL([
                        tx('Upstream of the point where scale forms — downhole or upstream of the choke — so the inhibitor is in the water before the pressure drop. Downstream of the protected equipment it does nothing.')
                    ]) + P(tx('Point ranking used by the page:')) + _suitLines(L, fams)),
                S('dose', 'Dose basis and typical range',
                    P(tx('Product as supplied, in ppm by mass on the water; set it at 1.5 to 2 times the MIC from the water analysis (the MIC is quoted as active).')) + _doseList(L, chems)),
                S('cautions', 'Key cautions',
                    UL([
                        tx('Methanol-rich water can precipitate some inhibitors, and high calcium can drop calcium phosphonate: test compatibility with the actual water and the other chemicals.'),
                        tx('Keep triazine and acidic scale inhibitors in separate lines, and cationic products apart from anionic inhibitors.'),
                        tx('Acidic products (pH 1 to 3) need suitable wetted materials and seals.'),
                        _sealTxt(L.elastomerRow('si_phosphonate'))
                    ]) + P(tx('Product cautions from the chemical library:')) + _cautionList(L, chems)),
                _compatSec(L, chems)
            ];
        }
    };

    TOPICS.process = {
        title: 'Foam and emulsion control', chip: 'Foam and emulsion',
        refs: ['kelland', 'mpms10'],
        lead: function () {
            return tx('Foam and emulsions spoil separation and metering in a well test: foam carries liquid into the gas line and flare and gas into the liquid meters; emulsions hold water in the oil and oil in the water, so rates and BS&W read wrong.');
        },
        build: function (L) {
            var fams = _famsOf(L, 'process'), chems = _chemsOf(L, fams);
            return [
                S('what', 'What it is and how it works',
                    P(tx('Antifoams (defoamers), silicone or non-silicone, spread over the bubble films and make the foam collapse. Demulsifiers (oxyalkylated resins and polyol blends) displace the natural emulsifiers at the oil–water interface so droplets coalesce. Water clarifiers (cationic polymers) gather oil droplets out of the separated water.'))),
                S('when', 'When to use it in a well test',
                    P(B('Use it')) + UL([
                        tx('When foam or emulsion is seen or expected: foaming crudes and condensates, clean-up with completion or stimulation fluids, cold or viscous oil, high shear across the choke.'),
                        tx('Choose the product and the dose by bottle test on fresh samples.')
                    ]) + P(B('Avoid')) + UL([
                        tx('A blanket dose without evidence: an overdose re-stabilises foam and emulsions.'),
                        tx('Silicone antifoam in crude for sale without checking the buyer\'s silicon limit (refinery catalysts).')
                    ])),
                S('where', 'Where to inject and why',
                    UL([
                        tx('Antifoam close to the separator (separator inlet), where the foam forms.'),
                        tx('Demulsifier upstream of the choke or downhole, so the choke shear mixes it in before the separator.'),
                        tx('Water clarifier at the separator water outlet.')
                    ]) + P(tx('Point ranking used by the page:')) + _suitLines(L, fams)),
                S('dose', 'Dose basis and typical range',
                    P(tx('Product as supplied, on the phase named in the dose basis. Antifoam rates are tiny: dilute so the pump runs in its range.')) + _doseList(L, chems)),
                S('cautions', 'Key cautions',
                    UL([
                        tx('Overdosing reverses the effect; bottle-test the whole chemical package (corrosion inhibitor, demulsifier, antifoam) together.'),
                        tx('Many products are in aromatic solvents with low flash points.')
                    ]) + P(tx('Product cautions from the chemical library:')) + _cautionList(L, chems)),
                _compatSec(L, chems)
            ];
        }
    };

    TOPICS.flow = {
        title: 'Wax and asphaltene control', chip: 'Wax and asphaltene',
        refs: ['kelland', 'd97'],
        lead: function () {
            return tx('Wax (paraffin) crystallises from crude and condensate below the wax appearance temperature; asphaltenes come out of solution as the pressure falls towards the bubble point. Both build deposits in the tubing, choke, heater and lines, and wax raises the pour point.');
        },
        build: function (L) {
            var fams = _famsOf(L, 'flow'), chems = _chemsOf(L, fams);
            return [
                S('what', 'What it is and how it works',
                    P(tx('Wax inhibitors (comb polymers such as EVA or polyacrylates) co-crystallise with the wax and keep the crystals small and non-sticking; pour-point depressants lower the temperature at which the oil stops flowing. Asphaltene inhibitors and dispersants keep asphaltene particles in suspension.'))),
                S('when', 'When to use it in a well test',
                    P(B('Use it')) + UL([
                        tx('When the wax appearance temperature is above the coldest point of the spread (cold weather, long lines, low rates, shut-ins).'),
                        tx('When a high-pour-point crude goes to tanks or lines that cool.'),
                        tx('When the asphaltene onset pressure lies between the reservoir and the flowing pressures.')
                    ]) + P(B('Not needed, or use another method')) + UL([
                        tx('If the oil stays above its wax appearance temperature throughout, or the onset pressure is never crossed.'),
                        tx('Heat (the heater, insulation) and solvent or hot-oil treatments are alternatives.')
                    ])),
                S('where', 'Where to inject and why',
                    UL([
                        tx('Wax inhibitor where the oil is still above the wax appearance temperature — downhole or upstream of the choke; the separator inlet is too late.'),
                        tx('Pour-point depressant into the oil leaving the separator.'),
                        tx('Asphaltene inhibitor below the onset-pressure depth (downhole).')
                    ]) + P(tx('Point ranking used by the page:')) + _suitLines(L, fams)),
                S('dose', 'Dose basis and typical range',
                    P(tx('Product as supplied, in ppm by volume on the oil or condensate:')) + _doseList(L, chems)),
                S('cautions', 'Key cautions',
                    UL([
                        tx('Use a winterised grade in cold weather: check the product pour point.'),
                        tx('Qualify asphaltene products on live oil; dead-oil tests can mislead.'),
                        tx('Products are in flammable solvents.')
                    ]) + P(tx('Product cautions from the chemical library:')) + _cautionList(L, chems)),
                _compatSec(L, chems)
            ];
        }
    };

    TOPICS.water = {
        title: 'Water-system chemicals', chip: 'Water systems',
        refs: ['kelland', 'rp45'],
        lead: function () {
            return tx('Biocides and oxygen scavengers protect stored or injected water; they are not normally used in a flowing test.');
        },
        build: function (L) {
            var fams = _famsOf(L, 'water'), chems = _chemsOf(L, fams);
            return [
                S('what', 'What it is and how it works',
                    P(tx('Biocides (glutaraldehyde, THPS, quaternary amines) kill sulfate-reducing and other bacteria that sour water and cause pitting. Oxygen scavengers (bisulfite) remove dissolved oxygen, which corrodes steel.'))),
                S('when', 'When to use it in a well test',
                    UL([
                        tx('Water stored for re-injection, hydrotest or disposal during an extended test; batch dosing is usual.'),
                        tx('Not in a normal flowing test.')
                    ])),
                S('where', 'Where to inject and why',
                    P(tx('Into the water: the separator water outlet or the tank.')) + _suitLines(L, fams)),
                S('dose', 'Dose basis and typical range', _doseList(L, chems)),
                S('cautions', 'Key cautions',
                    UL([tx('Never dose bisulfite together with aldehydes: they deactivate each other.')]) +
                    P(tx('Product cautions from the chemical library:')) + _cautionList(L, chems)),
                _compatSec(L, chems)
            ];
        }
    };

    TOPICS.custom = {
        title: 'Custom chemical', chip: 'Custom chemical',
        refs: ['sds', 'kelland'],
        lead: function () {
            return tx('A custom line takes the dose basis, dose, SG, viscosity and water content from the product data sheet.');
        },
        build: function (L) {
            var bases = Object.keys(L.bases).map(function (k) { return L.bases[k]; })
                .filter(function (b) { return b.phase !== 'thi' && (!_isM() || !(b.key === 'pt_mmscf' || b.key === 'gal_mmscf' || b.key === 'gal_lb_h2s')); });
            return [
                S('what', 'How to enter it',
                    P(tx('Pick the dose basis the data sheet uses, then the dose, SG, active content and water content. Bases the page accepts:')) +
                    UL(bases.map(function (b) { return tx('{l}', { l: b.label }); }))),
                S('where', 'Where to inject and why',
                    P(tx('Every point is allowed for a custom chemical: the page cannot judge the suitability, so follow the data sheet and the rules under Injection point selection.'))),
                S('cautions', 'Key cautions',
                    UL([
                        tx('Check compatibility with every other chemical on the spread and with the produced water by test.'),
                        tx('Check the flash point, toxicity and the seal compatibility from the safety data sheet.')
                    ]))
            ];
        }
    };

    TOPICS.points = {
        title: 'Injection point selection', chip: 'Injection points',
        refs: ['rp14c', 'iso10418', 'spec6a', 'gpsa', 'kelland'],
        lead: function () {
            return tx('Where a chemical goes in matters as much as how much: it must reach the right phase before the problem location, with enough mixing and contact time, at a tie-in that is safe at the shut-in pressure.');
        },
        build: function (L, o) {
            var out = [], p = o && o.point ? L.point(o.point) : null;
            if (p) {
                var c = o.chem ? L.find(o.chem) : null, si = c ? L.suitInfo(c.key, p.key) : null;
                out.push(S('sel', 'Your selection', UL([
                    B(p.label) + tx(': pressure basis {b}{r}.', { b: LINE_TXT[p.pLine] || p.pLine, r: BACK_TXT[p.pBack] ? '; ' + BACK_TXT[p.pBack] : '' }) + (p.note ? ' ' + tx('{n}', { n: p.note }) : ''),
                    tx('Typical pump: {t}.', { t: p.pumpClass }),
                    si ? tx('{s} for {c}{n}', { s: si.level === 'X' ? '✗ Not applicable' : (LEVEL_TXT[si.level] || si.level), c: c.short || c.name, n: _note(si) ? ': ' + _note(si) : '.' }) : ''
                ])));
            }
            out.push(
                S('rules', 'General rules',
                    UL([
                        tx('Upstream of the problem: hydrate inhibitor upstream of the choke, because Joule–Thomson cooling makes the choke outlet the coldest point; scale and corrosion inhibitors upstream of what they protect; wax inhibitor while the oil is still warm.'),
                        tx('Contact time: H2S scavenger as far upstream as practical (upstream of the choke), so the choke turbulence and the line to the separator give it time to react.'),
                        tx('Close to where the problem forms when it forms late: antifoam just upstream of the separator, water clarifier at the water outlet, pour-point depressant in the oil leaving the separator.'),
                        tx('Right phase: aqueous products need water to dissolve in and oil-soluble products need oil; at a gas outlet use an atomising quill and a knock-out downstream.')
                    ])),
                S('hardware', 'Tie-in hardware and pressure',
                    UL([
                        tx('Every tie-in: block valve, two check valves in series and a bleed, rated to the flowhead or manifold pressure class and leak-tested before the well is opened; inject through a quill into the centre of the flow.'),
                        tx('Points upstream of the choke see the shut-in tubing head pressure; points downstream see up to the separator relief-valve set pressure if the separator is blocked in.'),
                        tx('A tie-in upstream of the surface safety valve can bypass it; agree the ESD action of each chemical pump (trip, or keep running for shut-in hydrate protection) before the test.')
                    ])),
                S('points', 'The nine points used by the page',
                    UL(L.points.map(function (q) {
                        var rec = L.families.filter(function (f) { return f.suit[q.key] === 'R' && f.kind !== 'custom'; }).map(function (f) { return f.label; });
                        var alw = L.families.filter(function (f) { return f.suit[q.key] === 'A' && f.kind !== 'custom'; }).length;
                        return B(q.label) + tx(': pressure basis {b}. Typical pump: {t}. Recommended for: {r}.',
                            { b: LINE_TXT[q.pLine] || q.pLine, t: q.pumpClass, r: rec.length ? rec.join('; ') : (alw ? 'none (allowed for ' + alw + ' families)' : 'none') });
                    })))
            );
            return out;
        }
    };

    TOPICS.pumps = {
        title: 'Pump selection and calibration', chip: 'Pumps and calibration',
        refs: ['std675', 'std674', 'rp14c', 'std520', 'std521', 'rp500'],
        lead: function () {
            return tx('A chemical injection pump must deliver a small, steady rate against the highest pressure the tie-in can see, work in a hazardous area, and be checked in the field.');
        },
        build: function (L, o) {
            var D = L.defaults, out = [], P0 = o && o.pump ? L.pump(o.pump) : null;
            function pumpLine(q) {
                return B(q.name) + tx(': set by {s}. Accuracy: {a}. Turndown: {t}. {h}', {
                    s: SET_TXT[q.setting] || q.setting, a: q.accuracy, t: _cap(String(q.turndown || '').replace(/\s*\(edit\)/, '')), h: q.hazAreaNote
                });
            }
            if (P0) out.push(S('sel', 'Your selection', UL([pumpLine(P0),
                tx('Best suited to: {b}.', { b: (P0.bestPoints || []).map(function (k) { return _ptShort(L, k); }).join(', ') || 'see the point ranking' })])));
            out.push(
                S('choose', 'Choosing a pump',
                    UL([
                        tx('Pressure: the required discharge pressure is the line pressure at the point plus the quill and check-valve allowance ({q}); the discharge circuit is rated for the larger of +{pc} % and +{pa} above both that and the credible back-pressure (the shut-in pressure upstream of the choke, the separator relief-valve set pressure downstream) — not the operating pressure.',
                            { q: _dP(D.dpQuillPsi), pc: _nf(D.pumpMarginPct, 0), pa: _dP(D.pumpMarginPsi) }),
                        tx('Rate: the design rate times the peak factor (hydrate inhibitor {a}, scavenger {b}, other chemicals {c}) must fit the pump. Settings up to {g} % of the pump maximum are preferred (green), up to {am} % acceptable (amber); below {lo} % the rate becomes unsteady and below {mn} % it is out of range — choose a smaller plunger or pump.',
                            { a: _nf(D.peakThi, 2, 1), b: _nf(D.peakScav, 2, 1), c: _nf(D.peakOther, 2), g: _nf(D.bandGreenPct, 0), am: _nf(D.bandAmberPct, 0), lo: _nf(D.bandLowPct, 0), mn: _nf(D.bandMinPct, 0) }),
                        tx('Hazardous area: pneumatic and air-driven pumps have no electrics but vent their drive gas at the pump; electric pumps need motors and controls certified for the zone (area classification to API RP 500 / RP 505).'),
                        tx('Drive gas: instrument air, nitrogen or sweet gas; never sour produced gas unless the exhaust is routed to the flare.'),
                        tx('Protection: a relief valve on every pump discharge and drive-gas regulator, thermal relief on liquid-full sections that can be blocked in, and a block valve, two check valves and a bleed at every tie-in; size the tank vent for gas blow-by.'),
                        tx('Metering (controlled-volume) pumps to API Std 675 hold a steady-state accuracy of ±1 % over a 10:1 turndown; reciprocating plunger pumps are covered by API Std 674. Air-driven liquid pumps are not metering pumps: set the air pressure, then verify the rate.')
                    ])),
                S('types', 'Pump types in the library',
                    UL(L.pumps.filter(function (q) { return q.mvp; }).map(pumpLine))),
                S('cal', 'Field calibration (drawdown check)',
                    UL([
                        tx('Calibrate every pump on site with a graduated drawdown cylinder on the suction: isolate the tank, time the volume drawn at the actual discharge pressure, convert it to a rate and correct the setting.'),
                        tx('Repeat after any change of setting, chemical, temperature or discharge pressure, and compare the tank level with the expected use regularly.'),
                        tx('The page suggests a cylinder size for each line, and the Field calibration check compares the measured rate with the target (within 5 %) and gives a corrected setting.'),
                        tx('Air-driven liquid pumps must always be calibrated, at the pressure they will run against: their rate falls as the discharge pressure rises.')
                    ]))
            );
            return out;
        }
    };

    var STRIP = ['hydrate', 'ldhi', 'h2s', 'corrosion', 'scale', 'process', 'flow', 'points', 'pumps'];
    var ALL = STRIP.concat(['water', 'custom']);
    var FAM_TXT = {
        thi_alcohol: 'Alcohols (methanol, ethanol) are the usual well-test hydrate inhibitor: cheap, light, effective at low temperature and easy to pump, but volatile — a large share goes into the gas and condensate — and highly flammable.',
        thi_glycol: 'Glycols (MEG; DEG and TEG are rarely injected) stay almost entirely in the water, so losses are small and they are far less flammable than methanol, but they are viscous when cold and need a higher concentration for the same depression.',
        ldhi_khi: 'Kinetic hydrate inhibitors are water-soluble polymers that delay hydrate formation for a limited hold time at moderate subcooling.',
        ldhi_aa: 'Anti-agglomerants are surfactants that keep hydrate particles small and dispersed in the liquid hydrocarbon, so they flow as a slurry.',
        scav_aqueous: 'Water-based scavengers (triazines, glyoxal, aldehyde-releaser blends) for H2S in the gas, injected into the wet stream upstream of the separator.',
        scav_oil: 'Oil-soluble scavengers for H2S dissolved in crude or condensate, dosed into the oil leaving the separator or into the tank.',
        scav_oxidiser: 'Oxidisers (sodium nitrite, hydrogen peroxide) for sulfide in produced water only, with strong chemical hazards.',
        ci_oil: 'Oil-soluble film-forming corrosion inhibitors, carried by the oil to wet the steel: the usual choice for oil and condensate wells with produced water.',
        ci_aqueous: 'Water-soluble corrosion inhibitors, for streams where the water phase carries the inhibitor to the steel.',
        ci_gaswell: 'Gas-well corrosion inhibitors, atomised into the gas so the mist wets the pipe wall; continuous or batch.',
        scale: 'Threshold scale inhibitors (phosphonates and polymers) that stop carbonate and sulfate scale growing at a few ppm.',
        antifoam: 'Antifoams (defoamers), silicone or non-silicone, that collapse foam in the separator.',
        emulsion: 'Demulsifiers that break water-in-oil emulsions, so the separator gives dry oil and a true BS&W.',
        clarifier: 'Water clarifiers that gather oil droplets out of the separated water.',
        wax: 'Wax inhibitors (comb polymers) that keep wax crystals small and non-sticking; they must go in while the oil is still warm.',
        pour_point: 'Pour-point depressants that keep a waxy crude pourable as it cools in tanks and lines.',
        asphaltene: 'Asphaltene inhibitors and dispersants that keep asphaltene particles in suspension as the pressure falls.',
        water_systems: 'Biocides and oxygen scavengers for stored or injected water; not normally used in a flowing test.',
        custom: 'A product that is not in the library: the page uses the dose basis, dose and product data you enter from its data sheet.'
    };

    function topicFor(chemKey) {
        var L = _lib(), c = L && L.find(chemKey);
        if (!c) return null;
        if (c.kind === 'thi') return 'hydrate';
        if (c.kind === 'ldhi') return 'ldhi';
        return _has(TOPICS, c.group) ? c.group : 'custom';
    }

    // The two family sections shown first by the per-chemical button.
    function _famSections(L, c, fam) {
        var data = [tx('SG {s}', { s: _nf(c.sg, 3) })];
        if (_fin(c.activeDef)) data.push(tx('{a} % active', { a: _n(c.activeDef) }));
        if (c.kind !== 'thi' && _fin(c.water) && c.water > 0) data.push(tx('{w} wt % water', { w: _n(c.water * 100) }));
        if (_fin(c.flashF)) data.push(tx('flash point {f}', { f: _T(c.flashF) }));
        if (_fin(c.freezeF)) data.push(tx('freezing point {f}', { f: _T(c.freezeF) }));
        if (c.flammable) data.push(tx('flammable'));
        if (c.oxidiser) data.push(tx('oxidiser'));
        var rank = [];
        L.points.forEach(function (p) {
            var si = L.suitInfo(c.key, p.key);
            if (si && si.level !== 'X') rank.push(tx('{s} — {p}{n}', { s: LEVEL_TXT[si.level] || si.level, p: p.short, n: _note(si) ? ': ' + _note(si) : '' }));
        });
        return [
            S('sel', 'Selected chemical',
                UL([
                    B(c.name) + tx(' ({f}): {d}.', { f: fam.label, d: data.join(', ') }),
                    _doseItem(L, c),
                    c.cautions ? tx('Library cautions: {t}', { t: _lt(c.cautions) }) : '',
                    _sealTxt(L.elastomerRow(c.key))
                ].concat(_compatList(L, [c])))),
            S('rank', 'Point ranking for this chemical', UL(rank))
        ];
    }

    function content(key, opts) {
        opts = opts || {};
        var L = _lib();
        if (!L) return { ok: false, error: 'The chemical library is not loaded.' };
        var fam = null, chem = null;
        if (key === 'chem') {
            chem = L.find(opts.chem) || L.find('custom');
            if (!chem) return { ok: false, error: 'Unknown chemical.' };
            fam = L.family(chem.family);
            key = topicFor(chem.key);
        }
        var T = _has(TOPICS, key) ? TOPICS[key] : null;
        if (!T) return { ok: false, error: 'Unknown topic.' };
        var secs = T.build(L, opts).filter(function (s) { return s && s.html; });
        var title = T.title, lead = T.lead(L);
        if (fam) {
            title = fam.label;
            lead = tx('{t}', { t: FAM_TXT[fam.key] || fam.label });
            secs = _famSections(L, chem, fam).filter(function (s) { return s && s.html; }).concat(secs);
        }
        return {
            ok: true, key: key, family: fam ? fam.key : null, chem: chem ? chem.key : null,
            title: title, lead: lead, sections: secs, refs: T.refs.map(function (k) { return REF[k]; }), disclaimer: DISCLAIMER
        };
    }

    // ── Markup: buttons, row, stylesheet ─────────────────────────────
    function button(key, aria, n, sec) {
        return '<button type="button" class="cj-info rp-skip" data-rp-nosnap data-cj-info="' + _esc(key) + '"' +
            (n ? ' data-n="' + _esc(n) + '"' : '') + (sec ? ' data-sec="' + _esc(sec) + '"' : '') +
            ' aria-haspopup="dialog" aria-label="' + _esc(aria) + '" title="' + _esc(aria) + '"></button>';
    }
    function strip() {
        return '<div class="cj-info-row rp-skip" data-rp-nosnap role="group" aria-label="Background and standards">' +
            '<span class="cj-info-lab" aria-hidden="true">Background and standards</span>' +
            STRIP.map(function (k) { return '<button type="button" class="cj-info-chip" data-cj-info="' + k + '" aria-haspopup="dialog">' + _esc(TOPICS[k].chip) + '</button>'; }).join('') +
            '</div>';
    }
    var CSS = '<style>' +
        '#cj_root .cj-lab{display:flex;align-items:center;gap:2px;margin-bottom:5px;min-width:0}' +
        '#cj_root .cj-lab label{margin-bottom:0;min-width:0}' +
        '#cj_root .cj-info{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;min-width:0;min-height:0;margin:-6px 0;padding:0;border:0;border-radius:50%;background:transparent;color:var(--accent);cursor:pointer;vertical-align:middle;text-transform:none;letter-spacing:0;line-height:1}' +
        '#cj_root .cj-info::before,#cj_root .cj-info-chip::before{content:"i";display:inline-flex;align-items:center;justify-content:center;flex:none;width:15px;height:15px;box-sizing:border-box;border:1.5px solid currentColor;border-radius:50%;font:italic 700 10px/1 Georgia,"Times New Roman",serif;text-transform:none}' +
        '#cj_root .cj-info:hover{color:var(--text)}' +
        '#cj_root .cj-info:focus-visible,#cj_root .cj-info-chip:focus-visible,#cj_root .cj-dlg-x:focus-visible{outline:2px solid var(--accent);outline-offset:1px}' +
        '#cj_root .card-title .cj-info{margin:-6px 0 -6px 4px}' +
        '#cj_root .cj-info-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:12px}' +
        '#cj_root .cj-info-lab{font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;margin-right:2px}' +
        '#cj_root .cj-info-chip{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:3px 10px 3px 6px;border:1px solid var(--border);border-radius:14px;background:var(--bg2);color:var(--text2);font-size:12px;font-weight:600;cursor:pointer}' +
        '#cj_root .cj-info-chip::before{color:var(--accent)}' +
        '#cj_root .cj-info-chip:hover{border-color:var(--accent);color:var(--accent)}' +
        '#cj_root .cj-dlg-ov{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(1,4,9,.72);overscroll-behavior:contain}' +
        '#cj_root .cj-dlg{display:flex;flex-direction:column;width:min(780px,100%);max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);background:var(--bg2);border:1px solid var(--border);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.45);color:var(--text);outline:none}' +
        '#cj_root .cj-dlg-hd{display:flex;align-items:flex-start;gap:12px;padding:14px 16px 10px;border-bottom:1px solid var(--border)}' +
        '#cj_root .cj-dlg-hd h3{flex:1;min-width:0;margin:0;font-size:16px;line-height:1.3;color:var(--accent);overflow-wrap:anywhere}' +
        '#cj_root .cj-dlg-x{flex:none;width:32px;height:32px;margin:-5px -6px 0 0;padding:0;border:0;border-radius:6px;background:transparent;color:var(--text2);font-size:22px;line-height:1;cursor:pointer}' +
        '#cj_root .cj-dlg-x:hover{background:var(--bg3);color:var(--text)}' +
        '#cj_root .cj-dlg-bd{position:relative;flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:12px 16px 4px;font-size:13px;line-height:1.55;overflow-wrap:anywhere}' +
        '#cj_root .cj-dlg-bd:focus{outline:none}' +
        '#cj_root .cj-dlg-bd:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}' +
        '#cj_root .cj-dlg-lead{margin:0 0 6px;color:var(--text)}' +
        '#cj_root .cj-dlg-bd h4{margin:14px 0 4px;font-size:11.5px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.4px}' +
        '#cj_root .cj-dlg-bd p{margin:4px 0 6px;color:var(--text2)}' +
        '#cj_root .cj-dlg-bd ul{margin:4px 0 8px;padding-left:20px;color:var(--text2)}' +
        '#cj_root .cj-dlg-bd li{margin:3px 0}' +
        '#cj_root .cj-dlg-bd b{color:var(--text);font-weight:600}' +
        '#cj_root .cj-dlg-refs li{color:var(--text)}' +
        '#cj_root .cj-dlg-disc{margin:12px 0 12px;padding:8px 10px;border-left:3px solid var(--yellow);background:rgba(210,153,34,.08);color:var(--text)!important}' +
        '#cj_root .cj-dlg-ft{display:flex;justify-content:flex-end;padding:10px 16px;border-top:1px solid var(--border)}' +
        '@media (max-width:600px){#cj_root .cj-dlg-ov{padding:10px}#cj_root .cj-dlg{max-height:calc(100vh - 20px);max-height:calc(100dvh - 20px)}#cj_root .cj-dlg-bd{font-size:14px}#cj_root .cj-dlg-hd h3{font-size:15px}}' +
        '</style>';
    function css() { return CSS; }

    // ── Dialog ───────────────────────────────────────────────────────
    var _cur = null;   // {ov, dlg, bd, opener, key, down}
    function _dialogHtml(c) {
        var h = '<div class="cj-dlg" role="dialog" aria-modal="true" aria-labelledby="cj_info_title" aria-describedby="cj_info_lead" tabindex="-1" data-topic="' + _esc(c.key) + '"' +
            (c.family ? ' data-family="' + _esc(c.family) + '"' : '') + '>' +
            '<div class="cj-dlg-hd"><h3 id="cj_info_title">' + _esc(c.title) + '</h3>' +
            '<button type="button" class="cj-dlg-x" data-cj-close aria-label="Close">×</button></div>' +
            '<div class="cj-dlg-bd" tabindex="0" role="document" aria-labelledby="cj_info_title">' +
            '<p class="cj-dlg-lead" id="cj_info_lead">' + c.lead + '</p>';
        c.sections.forEach(function (s) { h += '<h4 data-sec="' + _esc(s.id) + '">' + _esc(s.h) + '</h4>' + s.html; });
        h += '<h4 data-sec="refs">Standards and references</h4><ul class="cj-dlg-refs">' +
            c.refs.map(function (r) { return '<li>' + _esc(r) + '</li>'; }).join('') + '</ul>' +
            '<p class="cj-dlg-disc">' + _esc(c.disclaimer) + '</p></div>' +
            '<div class="cj-dlg-ft"><button type="button" class="btn btn-secondary" data-cj-close>Close</button></div></div>';
        return h;
    }
    function _focusables() {
        if (!_cur || !_cur.dlg) return [];
        return Array.prototype.slice.call(_cur.dlg.querySelectorAll('button, [href], [tabindex]'))
            .filter(function (e) { return e.getAttribute('tabindex') !== '-1' && !e.disabled; });
    }
    function _onDown(e) { if (_cur) _cur.down = (e.target === _cur.ov); }
    function _onClick(e) {
        if (!_cur) return;
        var t = e.target;
        if (t === _cur.ov) {
            var fromOv = _cur.down !== false;      // a press that started inside the dialog and ended on the backdrop is not a backdrop click
            _cur.down = null;
            if (fromOv) close();
            return;
        }
        _cur.down = null;
        var b = (t && t.closest) ? t.closest('[data-cj-close]') : null;
        if (b && _cur.ov.contains(b)) close();
    }
    function _onKey(e) {
        if (!_cur) return;
        var k = e.key;
        if (k === 'Escape' || k === 'Esc') {
            if (e.preventDefault) e.preventDefault();
            if (e.stopPropagation) e.stopPropagation();
            close();
            return;
        }
        if (k !== 'Tab') return;
        var f = _focusables();
        if (!f.length) return;
        var a = (typeof document !== 'undefined') ? document.activeElement : null, i = f.indexOf(a);
        if (e.shiftKey) {
            if (i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        } else if (i === -1 || i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
    function isOpen() { return !!(_cur && _cur.ov && _cur.ov.parentNode && _cur.ov.isConnected !== false); }
    function close(noFocus) {
        var c = _cur;
        _cur = null;
        if (!c) return false;
        var was = !!(c.ov && c.ov.parentNode && c.ov.isConnected !== false);
        if (c.ov && c.ov.parentNode) c.ov.parentNode.removeChild(c.ov);
        if (was && noFocus !== true && c.opener && c.opener.isConnected !== false && typeof c.opener.focus === 'function') {
            try { c.opener.focus(); } catch (e) { /* focus is best effort */ }
        }
        return was;
    }
    function open(key, opts, opener, mount) {
        if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function') return null;
        var c = content(key, opts);
        if (!c.ok) return null;
        close(true);
        var host = mount || document.getElementById('cj_root') || document.body;
        if (!host) return null;
        var ov = document.createElement('div');
        ov.className = 'cj-dlg-ov rp-skip';
        ov.setAttribute('data-rp-nosnap', '');
        ov.innerHTML = _dialogHtml(c);
        host.appendChild(ov);
        _cur = { ov: ov, dlg: ov.querySelector('.cj-dlg'), bd: ov.querySelector('.cj-dlg-bd'), opener: opener || null, key: c.key, down: null };
        ov.addEventListener('mousedown', _onDown);
        ov.addEventListener('click', _onClick);
        ov.addEventListener('keydown', _onKey);
        var sec = opts && opts.section ? ov.querySelector('h4[data-sec="' + String(opts.section).replace(/[^a-z]/g, '') + '"]') : null;
        if (sec && _cur.bd) _cur.bd.scrollTop = Math.max(0, (sec.offsetTop || 0) - 8);
        try { (_cur.bd || _cur.dlg).focus(); } catch (e) { /* focus is best effort */ }
        return _cur.dlg;
    }

    G.WTS_cheminjInfo = {
        topics: STRIP.slice(),
        keys: function () { return ALL.slice(); },
        title: function (k) { return _has(TOPICS, k) ? TOPICS[k].title : ''; },
        topicFor: topicFor,
        content: content,
        button: button,
        strip: strip,
        css: css,
        open: open,
        close: function () { return close(false); },
        isOpen: isOpen,
        refs: REF
    };
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var I = G.WTS_cheminjInfo, fails = [];
    if (!I || !G.WTS_chemlib) return;
    I.keys().forEach(function (k) {
        var c = I.content(k);
        if (!c.ok || !c.title || c.sections.length < 2 || c.refs.length < 2) fails.push(k + ' content');
        if (/NaN|undefined|\{\w+\}/.test(JSON.stringify(c))) fails.push(k + ' bad token');
    });
    G.WTS_chemlib.chemicals.forEach(function (ch) { if (!I.content('chem', { chem: ch.key }).ok) fails.push('family of ' + ch.key); });
    if (fails.length && typeof console !== 'undefined') console.error('[cheminj-info self-test] FAILED:\n  ' + fails.join('\n  '));
})();
