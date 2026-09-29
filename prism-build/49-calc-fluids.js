// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 plug-in calculator — Cement & Completion Fluids (complfluids)
//
// PURPOSE (kept modest, roadmap #17)
//   A. Cement slurry: water requirement and yield of a neat slurry from its
//      density (absolute-volume mass balance), annular and shoe-track slurry
//      volume with open-hole excess, sacks, mix water and displacement.
//   B. Brine blending: density of a blend of two clear brines (volume
//      fractions) and the volumes of each for a target density, with
//      crystallisation-point and compatibility cautions. The salt list and
//      maximum densities are the Well Kill page's brine guide
//      (window.WTS_wellkill_brines, 48-calc-wellkill.js), not a copy.
//
// METHOD (references in brackets)
//   Absolute volume of cement = 1 / (SG·8.33) gal/lb (Class G / H SG 3.14
//   to 3.18 → 0.0382 gal/lb). Per sack of mass m (94 lb US):
//     ρ = (m + 8.33·w) / (m·v_c + w)  →  w = (m − ρ·m·v_c) / (ρ − 8.33)   gal/sk
//     yield Y = (m·v_c + w) / 7.4805 ft³/sk                               [API RP 10B-2 / Nelson & Guillot,
//                                                                            Well Cementing (2006) ch. 4]
//     Check: Class G neat at 15.8 ppg → 4.97 gal/sk (44 % water), 1.15 ft³/sk.
//   Capacities: annulus (Dh² − OD²)/1029.4 bbl/ft, pipe ID²/1029.4 bbl/ft.
//   Slurry = annulus·L·(1 + excess) + shoe track; sacks = slurry ft³ / Y;
//   mix water = sacks·w / 42 bbl; displacement = casing capacity × (shoe − shoe track).
//   Brine blend (ideal volume additivity, mass balance):
//     ρ_mix = (ρA·VA + ρB·VB) / (VA + VB);   VA = V·(ρt − ρB)/(ρA − ρB)    [API RP 13J, clear brine practice]
//
// PUBLIC API (window.*)
//   renderComplFluids(body), calcComplFluids()
//   WTS_complfluids_compute(input) → {ok, cement, blend} (each card validated separately)
//   WTS_cement_slurry(input), WTS_brine_blend(input)
//
// STATE  WTS_state.complfluids = {slurryBbl, sacks, yieldFt3, waterGalSk, mixWaterBbl, dispBbl,
//                                 blendPpg, vA, vB, ts, cement, blend}
// Registers window.WTS_calcRegistry.complfluids (group "Test System Safety", next to Well Kill).
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;
    var WATER_PPG = 8.33, GAL_FT3 = 7.4805, GAL_BBL = 42, K_CAP = 1029.4;
    var FT3_BBL = 5.6146;
    // Fallback when the Well Kill page is not loaded (same values, guidance only).
    var FALLBACK = [
        { name: 'Fresh water', ppg: 8.33 }, { name: 'Seawater', ppg: 8.55 },
        { name: 'Potassium chloride, KCl', ppg: 9.7 }, { name: 'Sodium chloride, NaCl', ppg: 10.0 },
        { name: 'Calcium chloride, CaCl2', ppg: 11.6 }, { name: 'Calcium bromide, CaBr2', ppg: 14.2 }
    ];
    function _brines() {
        var b = G.WTS_wellkill_brines;
        return (b && b.length) ? b : FALLBACK;
    }
    function _fin(x) { return typeof x === 'number' && isFinite(x); }
    function _isCa(n) { return /calcium|CaCl2|CaBr2/i.test(n); }
    function _isSulphateOrFormate(n) { return /seawater|formate/i.test(n); }

    // ── A. Cement slurry ─────────────────────────────────────────────
    // input = {dh in (hole), od in (casing OD), cid in (casing ID), shoe ft MD, toc ft MD,
    //          track ft (shoe track), excess %, rho ppg, sgc (cement SG), sack lb}
    function cement(input) {
        var i = input || {}, errors = [], bad = [];
        function need(ok, key, msg) { if (!ok) { errors.push(msg); bad.push(key); } return ok; }
        var dh = Number(i.dh), od = Number(i.od), cid = Number(i.cid), shoe = Number(i.shoe), toc = Number(i.toc);
        var track = Number(i.track), ex = Number(i.excess), rho = Number(i.rho), sgc = Number(i.sgc), sack = Number(i.sack);
        var odOk = need(_fin(od) && od > 0 && od <= 30, 'od', 'Casing OD must be above 0 and no more than 30 in.');
        need(_fin(dh) && dh > 0 && dh <= 48 && (!odOk || dh > od), 'dh', 'Hole diameter must be larger than the casing OD and no more than 48 in.');
        need(_fin(cid) && cid > 0 && (!odOk || cid < od), 'cid', 'Casing ID must be above 0 and below the casing OD.');
        var shoeOk = need(_fin(shoe) && shoe > 0 && shoe <= 40000, 'shoe', 'Casing shoe depth must be above 0 and no more than 40,000 ft.');
        need(_fin(toc) && toc >= 0 && (!shoeOk || toc < shoe), 'toc', 'Top of cement must be 0 or deeper and above the casing shoe.');
        need(_fin(track) && track >= 0 && (!shoeOk || track < shoe), 'track', 'Shoe track length must be 0 or more and shorter than the shoe depth.');
        need(_fin(ex) && ex >= 0 && ex <= 300, 'excess', 'Open-hole excess must be between 0 and 300 %.');
        var sgOk = need(_fin(sgc) && sgc >= 2 && sgc <= 4, 'sgc', 'Cement specific gravity must be between 2 and 4.');
        need(_fin(sack) && sack > 0 && sack <= 200, 'sack', 'Sack weight must be above 0 and no more than 200 lb.');
        var rhoMax = sgOk ? sgc * WATER_PPG : 30;
        need(_fin(rho) && rho > WATER_PPG + 0.5 && rho < rhoMax - 0.5, 'rho', 'Slurry density must lie between water (8.83 ppg) and the dry cement density minus 0.5 ppg.');
        if (errors.length) return { ok: false, errors: errors, bad: bad };

        var vc = 1 / (sgc * WATER_PPG);                 // gal/lb absolute volume
        var absGal = sack * vc;                         // gal per sack
        var w = (sack - rho * absGal) / (rho - WATER_PPG);
        var yieldFt3 = (absGal + w) / GAL_FT3;
        var wcr = w * WATER_PPG / sack;                 // water / cement mass ratio
        var annCap = (dh * dh - od * od) / K_CAP, pipeCap = cid * cid / K_CAP;
        var annLen = shoe - toc;
        var annBbl = annCap * annLen, annEx = annBbl * (1 + ex / 100), trackBbl = pipeCap * track;
        var slurry = annEx + trackBbl, slurryFt3 = slurry * FT3_BBL;
        var sacks = slurryFt3 / yieldFt3;
        var mixWater = sacks * w / GAL_BBL;
        var disp = pipeCap * (shoe - track);
        return {
            ok: true, waterGalSk: w, yieldFt3: yieldFt3, wcr: wcr, absGalSk: absGal,
            annCap: annCap, pipeCap: pipeCap, annLen: annLen, annBbl: annBbl, annExBbl: annEx, excessBbl: annEx - annBbl,
            trackBbl: trackBbl, slurryBbl: slurry, slurryFt3: slurryFt3, sacks: sacks, sacksRounded: Math.ceil(sacks - 1e-9),
            mixWaterBbl: mixWater, dispBbl: disp,
            lowWater: wcr < 0.35, highWater: wcr > 0.60
        };
    }

    // ── B. Brine blend ────────────────────────────────────────────────
    // input = {a, b: brine indices into the guide (or -1 = other), ra, rb ppg, va, vb bbl,
    //          target ppg (blank → none), vt bbl (final volume for the target)}
    function blend(input) {
        var i = input || {}, errors = [], bad = [];
        function need(ok, key, msg) { if (!ok) { errors.push(msg); bad.push(key); } return ok; }
        var list = _brines();
        var ia = parseInt(i.a, 10), ib = parseInt(i.b, 10);
        var A = (ia >= 0 && ia < list.length) ? list[ia] : null, B = (ib >= 0 && ib < list.length) ? list[ib] : null;
        var ra = Number(i.ra), rb = Number(i.rb), va = Number(i.va), vb = Number(i.vb);
        var tgt = (i.target == null || i.target === '' || (typeof i.target === 'number' && isNaN(i.target))) ? null : Number(i.target);
        var vt = Number(i.vt);
        var raOk = need(_fin(ra) && ra >= 6 && ra <= 25, 'ra', 'Brine A density must be between 6 and 25 ppg.');
        var rbOk = need(_fin(rb) && rb >= 6 && rb <= 25, 'rb', 'Brine B density must be between 6 and 25 ppg.');
        need(_fin(va) && va >= 0 && va <= 1e5, 'va', 'Brine A volume must be between 0 and 100,000 bbl.');
        need(_fin(vb) && vb >= 0 && vb <= 1e5 && (!_fin(va) || va + vb > 0), 'vb', 'Brine B volume must be 0 or more, with a total above 0.');
        if (tgt != null) {
            var lo = Math.min(ra, rb), hi = Math.max(ra, rb);
            need(_fin(tgt) && raOk && rbOk && Math.abs(ra - rb) > 1e-6 && tgt >= lo - 1e-9 && tgt <= hi + 1e-9, 'target',
                'Target density must lie between the two brine densities, and the brines must differ.');
            need(_fin(vt) && vt > 0 && vt <= 1e5, 'vt', 'Final blend volume must be above 0 and no more than 100,000 bbl.');
        }
        if (errors.length) return { ok: false, errors: errors, bad: bad };
        var v = va + vb, mix = (ra * va + rb * vb) / v;
        var out = {
            ok: true, a: A ? A.name : 'Other brine', b: B ? B.name : 'Other brine', aMax: A ? A.ppg : null, bMax: B ? B.ppg : null,
            ra: ra, rb: rb, va: va, vb: vb, vol: v, fa: va / v, fb: vb / v, mix: mix, sg: mix / WATER_PPG, kgm3: mix * 119.826,
            target: null, cautions: []
        };
        if (tgt != null) {
            var fa = Math.abs(ra - rb) > 1e-9 ? (tgt - rb) / (ra - rb) : 1;
            out.target = { ppg: tgt, vt: vt, fa: fa, va: vt * fa, vb: vt * (1 - fa) };
        }
        // Cautions (guidance)
        [['A', A, ra], ['B', B, rb]].forEach(function (x) {
            if (!x[1]) return;
            if (x[2] > x[1].ppg + 1e-9) out.cautions.push({ lvl: 'bad', t: 'Brine ' + x[0] + ' is above the usual maximum density of ' + x[1].name + ' (' + x[1].ppg.toFixed(2) + ' ppg). It cannot be made or will crystallise.' });
            else if (x[2] >= 0.97 * x[1].ppg && x[1].ppg > 8.6) out.cautions.push({ lvl: 'warn', t: 'Brine ' + x[0] + ' is within 3 % of the maximum density of ' + x[1].name + ': the crystallisation temperature rises steeply here.' });
        });
        if (A && B && A.name !== B.name) out.cautions.push({ lvl: 'warn', t: 'Two different salts: the blend crystallisation temperature is not the average of the two. Confirm TCT with the supplier.' });
        if (A && B && ((_isCa(A.name) && _isSulphateOrFormate(B.name)) || (_isCa(B.name) && _isSulphateOrFormate(A.name))))
            out.cautions.push({ lvl: 'warn', t: 'Calcium brine with seawater or formate: calcium sulphate, carbonate or formate may precipitate. Test compatibility.' });
        return out;
    }

    function compute(input) {
        var i = input || {};
        return { ok: true, cement: cement(i.cement), blend: blend(i.blend) };
    }
    G.WTS_cement_slurry = cement;
    G.WTS_brine_blend = blend;
    G.WTS_complfluids_compute = compute;

    // ── Page ─────────────────────────────────────────────────────────
    var TITLE = 'Cement & Completion Fluids';
    var SUB = 'Neat cement slurry water requirement, yield, sacks and volumes; two-brine blending density with crystallisation cautions';
    var UNITS = {
        cmf_dh: 'lengthSmall', cmf_od: 'lengthSmall', cmf_cid: 'lengthSmall', cmf_shoe: 'length', cmf_toc: 'length',
        cmf_track: 'length', cmf_ex: 'percent', cmf_rho: 'densityLiquid', cmf_sgc: 'sg', cmf_sack: 'mass',
        cmf_ra: 'densityLiquid', cmf_rb: 'densityLiquid', cmf_va: 'volume', cmf_vb: 'volume', cmf_tgt: 'densityLiquid', cmf_vt: 'volume'
    };
    var CIDS = { dh: 'cmf_dh', od: 'cmf_od', cid: 'cmf_cid', shoe: 'cmf_shoe', toc: 'cmf_toc', track: 'cmf_track', excess: 'cmf_ex', rho: 'cmf_rho', sgc: 'cmf_sgc', sack: 'cmf_sack' };
    var BIDS = { ra: 'cmf_ra', rb: 'cmf_rb', va: 'cmf_va', vb: 'cmf_vb', target: 'cmf_tgt', vt: 'cmf_vt' };

    function _byId(id) { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null; }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _str(id) { var e = _byId(id); return e ? String(e.value) : ''; }
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) });
    }
    function _fx(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
    }
    function _metric() { var U = G.WTS_units; return !!(U && U.getSystem && U.getSystem() === 'metric'); }
    function _u(v, cat, d, impLabel, dMet) {
        var U = G.WTS_units;
        if (_metric() && U.format) { var f = U.format(v, cat); return _fmt(f.value, dMet == null ? d : dMet) + ' ' + f.label; }
        return _fmt(v, d) + ' ' + impLabel;
    }
    function _tag(map) { var U = G.WTS_units; if (!U || !U.tagInput) return; for (var id in map) U.tagInput(id, map[id]); }
    function _canon(fn) { var U = G.WTS_units; return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }
    function _fg(id, label, val, extra) {
        return '<div class="fg-item"><label for="' + id + '">' + label + '</label>' +
            '<input type="number" id="' + id + '" value="' + val + '" step="any"' + (extra || '') + '></div>';
    }
    function _sel(id, label, opts, val) {
        var h = '<div class="fg-item"><label for="' + id + '">' + label + '</label><select id="' + id + '">';
        opts.forEach(function (o) { h += '<option value="' + o.v + '"' + (o.v === val ? ' selected' : '') + '>' + o.t + '</option>'; });
        return h + '</select></div>';
    }
    function _row(l, v) { return '<div class="rrow"><span class="rl">' + l + '</span><span class="rv">' + v + '</span></div>'; }
    function _ok(t) { return '<div style="color:var(--green)">✓ ' + t + '</div>'; }
    function _warn(t) { return '<div style="color:var(--yellow)">⚠ ' + t + '</div>'; }
    function _bad(t) { return '<div style="color:var(--red)">✗ ' + t + '</div>'; }
    function _note(t) { return '<div style="margin-top:10px;font-size:12px;color:var(--text2)"><b>Notes</b> ' + t + '</div>'; }
    function _tbl(head, rows) {
        return '<div style="overflow-x:auto"><table class="dtable"><thead><tr>' + head.map(function (h) { return '<th>' + h + '</th>'; }).join('') +
            '</tr></thead><tbody>' + rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('') +
            '</tbody></table></div>';
    }
    function _den(v) { return _u(v, 'densityLiquid', 2, 'ppg', 3); }
    function _ppg3(v) { return _fx(v, 2) + ' ppg · SG ' + _fx(v / WATER_PPG, 3) + ' · ' + _fmt(v * 119.826, 0) + ' kg/m³'; }
    var V = function (v) { return _u(v, 'volume', 1, 'bbl', 2); };
    var MSG = {
        od: function () { return 'Casing OD must be above 0 and no more than ' + _u(30, 'lengthSmall', 0, 'in') + '.'; },
        dh: function () { return 'Hole diameter must be larger than the casing OD and no more than ' + _u(48, 'lengthSmall', 0, 'in') + '.'; },
        shoe: function () { return 'Casing shoe depth must be above 0 and no more than ' + _u(40000, 'length', 0, 'ft') + '.'; },
        rho: function () { return 'Slurry density must lie between water (' + _den(8.83) + ') and the dry cement density minus ' + _den(0.5) + '.'; },
        sack: function () { return 'Sack weight must be above 0 and no more than ' + _u(200, 'mass', 0, 'lb') + '.'; },
        ra: function () { return 'Brine A density must be between ' + _den(6) + ' and ' + _den(25) + '.'; },
        rb: function () { return 'Brine B density must be between ' + _den(6) + ' and ' + _den(25) + '.'; },
        va: function () { return 'Brine A volume must be between 0 and ' + _u(1e5, 'volume', 0, 'bbl') + '.'; },
        vt: function () { return 'Final blend volume must be above 0 and no more than ' + _u(1e5, 'volume', 0, 'bbl') + '.'; }
    };
    function _errors(resId, ids, r) {
        var res = _byId(resId), items = '', seen = {};
        r.bad.forEach(function (k, j) {
            var el = _byId(ids[k]); if (el && el.classList) el.classList.add('input-err');
            if (seen[k]) return; seen[k] = 1;
            items += '<li>' + (MSG[k] ? MSG[k]() : r.errors[j]) + '</li>';
        });
        if (res) { res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' + items + '</ul></div>'; res.setAttribute('data-done', '1'); }
    }

    function _paintCement(r) {
        var res = _byId('cmf_cres');
        if (!res) return;
        if (!r.ok) { _errors('cmf_cres', CIDS, r); return; }
        var v = '';
        if (r.lowWater) v += _warn('Water-to-cement ratio ' + _fx(r.wcr, 2) + ' is below about 0.35: a dispersant is needed to mix and pump this slurry.');
        else if (r.highWater) v += _warn('Water-to-cement ratio ' + _fx(r.wcr, 2) + ' is above about 0.60: expect free water and low strength without an extender.');
        else v += _ok('Water-to-cement ratio ' + _fx(r.wcr, 2) + ' is in the normal neat-slurry range.');
        res.innerHTML =
            '<div class="rbox"><div class="rbox-title">Slurry Design</div>' +
            _row('Water requirement', _fx(r.waterGalSk, 2) + ' gal/sack (' + _fx(r.waterGalSk * 3.78541, 1) + ' L/sack)') +
            _row('Water-to-cement ratio', _fx(r.wcr * 100, 1) + ' % by mass') +
            _row('Slurry yield', _fx(r.yieldFt3, 3) + ' ft³/sack (' + _fx(r.yieldFt3 * 28.3168, 1) + ' L/sack)') +
            v + '</div>' +
            '<div class="rbox"><div class="rbox-title">Slurry Volume &amp; Sacks</div>' +
            _tbl(['Section', 'Length', 'Capacity', 'Volume'], [
                ['Annulus, casing x hole', _u(r.annLen, 'length', 0, 'ft', 1), _u(r.annCap, 'capacity', 5, 'bbl/ft', 5), V(r.annBbl)],
                ['Open-hole excess', '', '', V(r.excessBbl)],
                ['Shoe track', '', _u(r.pipeCap, 'capacity', 5, 'bbl/ft', 5), V(r.trackBbl)]
            ]) +
            _row('Total slurry', V(r.slurryBbl) + ' (' + _fmt(r.slurryFt3, 0) + ' ft³)') +
            _row('Cement', _fmt(r.sacksRounded, 0) + ' sacks') +
            _row('Mix water', V(r.mixWaterBbl)) +
            _row('Displacement to the float collar', V(r.dispBbl)) +
            _note('Neat cement only: additives change the absolute volume and water demand, so use the laboratory yield for a ' +
                'designed slurry. Yield and water from the absolute-volume mass balance (API RP 10B-2). Excess applies to the ' +
                'open-hole annulus; use a caliper log where available.') +
            '</div>';
        res.setAttribute('data-done', '1');
    }

    function _paintBlend(r) {
        var res = _byId('cmf_bres');
        if (!res) return;
        if (!r.ok) { _errors('cmf_bres', BIDS, r); return; }
        var h = '<div class="rbox"><div class="rbox-title">Brine Blend</div>' +
            _tbl(['Brine', 'Density', 'Volume', 'Fraction', 'Guide max'], [
                ['A: ' + r.a, _den(r.ra), V(r.va), _fx(r.fa * 100, 1) + ' %', r.aMax == null ? '—' : _den(r.aMax)],
                ['B: ' + r.b, _den(r.rb), V(r.vb), _fx(r.fb * 100, 1) + ' %', r.bMax == null ? '—' : _den(r.bMax)]
            ]) +
            _row('Blend volume', V(r.vol)) +
            _row('Blend density', _ppg3(r.mix));
        if (r.target) {
            h += _row('Target density', _ppg3(r.target.ppg)) +
                _row('Brine A for target', V(r.target.va) + ' (' + _fx(r.target.fa * 100, 1) + ' %)') +
                _row('Brine B for target', V(r.target.vb));
        }
        var v = r.cautions.map(function (c) { return c.lvl === 'bad' ? _bad(c.t) : _warn(c.t); }).join('');
        if (!r.cautions.length) v = _ok('No crystallisation or compatibility flags for this pair.');
        h += v + _note('Densities at surface temperature (about 70 °F). Volumes are taken as additive; real blends can shrink by up to about 1 %. ' +
            'Brine density falls as temperature rises. The crystallisation temperature (TCT) rises steeply near the maximum density ' +
            'and with pressure; order the blend to a TCT below the lowest temperature it will see, including seabed and surface lines. ' +
            'Guide densities from the Well Kill page brine guide.') + '</div>';
        res.innerHTML = h;
        res.setAttribute('data-done', '1');
    }

    function _readCement() {
        return { dh: _num('cmf_dh'), od: _num('cmf_od'), cid: _num('cmf_cid'), shoe: _num('cmf_shoe'), toc: _num('cmf_toc'),
            track: _num('cmf_track'), excess: _num('cmf_ex'), rho: _num('cmf_rho'), sgc: _num('cmf_sgc'), sack: _num('cmf_sack') };
    }
    function _readBlend() {
        return { a: _str('cmf_a'), b: _str('cmf_b'), ra: _num('cmf_ra'), rb: _num('cmf_rb'), va: _num('cmf_va'), vb: _num('cmf_vb'),
            target: _num('cmf_tgt'), vt: _num('cmf_vt') };
    }
    function _calcImpl() {
        var root = _byId('cmf_root');
        if (!root) return null;
        var ins = root.querySelectorAll ? root.querySelectorAll('input,select') : [];
        for (var n = 0; n < ins.length; n++) if (ins[n].classList) ins[n].classList.remove('input-err');
        var c = cement(_readCement()), b = blend(_readBlend());
        _paintCement(c);
        _paintBlend(b);
        G.WTS_state = G.WTS_state || {};
        G.WTS_state.complfluids = {
            slurryBbl: c.ok ? c.slurryBbl : null, sacks: c.ok ? c.sacks : null, yieldFt3: c.ok ? c.yieldFt3 : null,
            waterGalSk: c.ok ? c.waterGalSk : null, mixWaterBbl: c.ok ? c.mixWaterBbl : null, dispBbl: c.ok ? c.dispBbl : null,
            blendPpg: b.ok ? b.mix : null, vA: b.ok && b.target ? b.target.va : null, vB: b.ok && b.target ? b.target.vb : null,
            ts: Date.now(), cement: c, blend: b
        };
        return { cement: c, blend: b };
    }
    G.calcComplFluids = function () { return _canon(_calcImpl); };

    function render(body) {
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        var bl = _brines();
        var opts = bl.map(function (b, k) { return { v: String(k), t: b.name + ' (max ' + b.ppg.toFixed(1) + ' ppg)' }; });
        opts.push({ v: '-1', t: 'Other brine' });
        function idx(re, def) { for (var k = 0; k < bl.length; k++) if (re.test(bl[k].name)) return String(k); return def; }
        var btn = '<div class="btn-row"><button class="btn btn-primary" onclick="calcComplFluids()">Calculate</button></div>';
        body.innerHTML =
            '<div id="cmf_root"><div class="cols-2">' +
            '<div>' +
            '<div class="card"><div class="card-title">Cement Slurry</div><div class="fg">' +
            _fg('cmf_dh', 'Hole diameter (in)', '8.5', ' min="0"') +
            _fg('cmf_od', 'Casing OD (in)', '7', ' min="0"') +
            _fg('cmf_cid', 'Casing ID (in)', '6.276', ' min="0"') +
            _fg('cmf_shoe', 'Casing shoe depth, MD (ft)', '10000', ' min="0"') +
            _fg('cmf_toc', 'Top of cement, MD (ft)', '8000', ' min="0"') +
            _fg('cmf_track', 'Shoe track length (ft)', '80', ' min="0"') +
            _fg('cmf_ex', 'Open-hole excess (%)', '20', ' min="0"') +
            _fg('cmf_rho', 'Slurry density (ppg)', '15.8', ' min="0"') +
            _fg('cmf_sgc', 'Cement specific gravity', '3.14', ' min="0"') +
            _fg('cmf_sack', 'Sack weight (lb)', '94', ' min="0"') +
            '</div>' + btn.replace('<button', '<button id="cmf_calc"') + '<div id="cmf_cres" style="margin-top:14px"></div></div>' +
            '</div>' +
            '<div>' +
            '<div class="card"><div class="card-title">Brine Blending</div><div class="fg">' +
            _sel('cmf_a', 'Brine A', opts, idx(/^Calcium bromide/i, '0')) +
            _fg('cmf_ra', 'Brine A density (ppg)', '14.2', ' min="0"') +
            _fg('cmf_va', 'Brine A volume (bbl)', '100', ' min="0"') +
            _sel('cmf_b', 'Brine B', opts, idx(/^Calcium chloride/i, '0')) +
            _fg('cmf_rb', 'Brine B density (ppg)', '11.6', ' min="0"') +
            _fg('cmf_vb', 'Brine B volume (bbl)', '100', ' min="0"') +
            _fg('cmf_tgt', 'Target density, optional (ppg)', '13.0', ' min="0"') +
            _fg('cmf_vt', 'Final blend volume for the target (bbl)', '300', ' min="0"') +
            '</div>' + btn.replace('<button', '<button id="cmf_bcalc"') + '<div id="cmf_bres" style="margin-top:14px"></div></div>' +
            '</div>' +
            '</div></div>';
        _tag(UNITS);
        var root = _byId('cmf_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                if (e && e.target && /^cmf_/.test(e.target.id || '')) G.calcComplFluids();
            });
        }
        G.calcComplFluids();
    }
    G.renderComplFluids = render;

    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.complfluids = {
        key: 'complfluids',
        title: TITLE,
        navTitle: 'Cement & Brines',
        sub: SUB,
        group: 'Test System Safety',
        icon: '&#9707;',
        badge: 'Completions',
        bc: 'dc-b-blue',
        desc: 'Neat cement water requirement, yield, sacks and displacement; two-brine blend density and target volumes with crystallisation cautions.',
        render: function (body) { return G.renderComplFluids(body); }
    };

    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var ids = ['cmf_cres', 'cmf_bres'];
            for (var n = 0; n < ids.length; n++) {
                var r = _byId(ids[n]);
                if (r && r.getAttribute && r.getAttribute('data-done') === '1') { G.calcComplFluids(); return; }
            }
        });
    }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var fails = [], n = 0;
    function near(a, b, tol, what) { n++; if (!(isFinite(a) && Math.abs(a - b) <= tol)) fails.push(what + ': got ' + a + ', expected ' + b); }
    // Class G neat, 15.8 ppg: 4.97 gal/sk and 1.15 ft³/sk (API Class G, 44 % water)
    var c = G.WTS_cement_slurry({ dh: 8.5, od: 7, cid: 6.276, shoe: 10000, toc: 8000, track: 80, excess: 20, rho: 15.8, sgc: 3.14, sack: 94 });
    near(c.waterGalSk, 4.97, 0.03, 'Class G water'); near(c.yieldFt3, 1.15, 0.01, 'Class G yield');
    var b = G.WTS_brine_blend({ a: -1, b: -1, ra: 12, rb: 10, va: 30, vb: 70, target: 11, vt: 100 });
    near(b.mix, 10.6, 1e-9, 'blend'); near(b.target.va, 50, 1e-9, 'target');
    if (fails.length) {
        if (typeof console !== 'undefined') console.error('[complfluids self-test] ' + fails.length + '/' + n + ' FAILED:\n  ' + fails.join('\n  '));
        if (typeof window === 'undefined' && typeof process !== 'undefined') process.exitCode = 1;
    } else if (typeof console !== 'undefined') {
        console.log('[complfluids self-test] ' + n + '/' + n + ' checks passed');
    }
})();
