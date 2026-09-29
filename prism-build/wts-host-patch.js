#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
// wts-host-patch.js — Round-7 host edits for the Live 3D Well Test
// Simulator (spec §3.1 / §3.6, H1–H8 + critic amendments).
//
// Idempotent, anchored exact-string replacements on well-testing-app.html.
// Every edit is scoped to a region of the file (the Well Test Simulator
// section, the GA_EVENTS list, collectPageReport, the job-report snapshot
// listener) so unrelated edits elsewhere in the file never move an anchor.
// An edit whose "done" marker is already present in its region is skipped;
// otherwise its anchor must occur EXACTLY once in the region.
//
// Usage (from the repo root):
//   node prism-build/wts-host-patch.js [--check]        dry run (the DEFAULT — never writes)
//   node prism-build/wts-host-patch.js --apply          apply in place (writes <file>.bak first)
//   node prism-build/wts-host-patch.js --file a.html --out b.html
//   node prism-build/wts-host-patch.js --json           machine-readable report
//   node prism-build/wts-host-patch.js --help           usage
//
// Writing requires an explicit --apply (alias --write) or --out; unknown
// flags print usage and exit 2, so a typo can never patch the host file.
// Exit code: 0 when every edit is applied/applicable; 1 on anchor problems;
// 2 on bad usage.
//
// Not applied (lead amendment L2): the metric gv() change of spec H4a —
// the 22-units canonical context already makes tagged inputs return
// imperial values inside window.calc* calls, so reading through
// WTS_units.readInput would double-convert.
//
// require()-able: module.exports = { EDITS, patch, main, parseArgs, USAGE }.
// ════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_HTML = path.join(ROOT, 'well-testing-app.html');

// ── Regions ────────────────────────────────────────────────────────
const WTS_SECTION = '// ── Well Test Simulator ──';
function regionWTS(t) {
  const a = t.indexOf(WTS_SECTION);
  if (a < 0) return null;
  // The WTS section runs to the host's "Initial render" call.
  const b = t.indexOf('// ── Initial render ──', a);
  return [a, b < 0 ? t.length : b + '// ── Initial render ──'.length];
}
function regionFn(startNeedle, endNeedle) {
  return function (t) {
    const a = t.indexOf(startNeedle);
    if (a < 0) return null;
    // The end needle may span a line break: accept LF or CRLF.
    let best = -1, len = 0;
    for (const n of [endNeedle, endNeedle.replace(/\n/g, '\r\n')]) {
      const b = t.indexOf(n, a + startNeedle.length);
      if (b >= 0 && (best < 0 || b < best)) { best = b; len = n.length; }
    }
    return [a, best < 0 ? t.length : best + len];
  };
}
const regionCalc = regionFn('window.calcWTS=function(){', 'function wtsDrawDiag(');
const regionRender = regionFn('function renderWTS(body){', 'window.calcWTS=function(){');
const regionDiag = function (t) {
  const r = regionWTS(t); if (!r) return null;
  const a = t.indexOf('function wtsDrawDiag(', r[0]);
  return a < 0 ? null : [a, r[1]];
};
const regionGA = regionFn('const GA_EVENTS = [', '\n];');
const regionCollect = regionFn('function collectPageReport(root, opts) {', '\n}\n');
const regionSnap = regionFn("['input', 'change', 'click'].forEach(t => document.addEventListener(t, e => {", '}, true));');

// ── Shared literals ────────────────────────────────────────────────
const IDS_OLD = "['wts_Pwh','wts_Twh','wts_Qg','wts_Qo','wts_Qw','wts_SGg','wts_API','wts_bean','wts_Cd','wts_Thtr','wts_htrEff','wts_bypass','wts_Psep','wts_nps1','wts_sch1','wts_len1','wts_nps2','wts_sch2','wts_len2','wts_nps3','wts_sch3','wts_len3','wts_nps4','wts_sch4','wts_len4','wts_nps5','wts_sch5','wts_len5','wts_nps6','wts_sch6','wts_len6','wts_Cfac','wts_eps']";
const IDS_NEW = IDS_OLD.slice(0, -1) + ",'wts_sepID','wts_sepL','wts_Psurge','wts_surgeCap','wts_gtCap']";

// ── Edits ──────────────────────────────────────────────────────────
// {id, spec, region, find, replace, done}  — plain replace of `find`
// {id, spec, region, from, to, replace, done, mustContain} — range replace
//     of [from, to) (to = first occurrence after from; `toInclusive` keeps
//     the `to` needle inside the replaced range).
const EDITS = [
  // H1 — WTS_IDS hoisted and shared by renderWTS/calcWTS (+5 new inputs)
  { id: 'H1-ids-const', spec: 'H1', region: regionWTS,
    find: 'function renderWTS(body){',
    replace: 'const WTS_IDS=' + IDS_NEW + ';\nfunction renderWTS(body){',
    done: 'const WTS_IDS=[' },
  { id: 'H1-render-load', spec: 'H1', region: regionRender,
    find: '    const ids=' + IDS_OLD + ';\n    loadInputs(\'wts\',ids);',
    replace: "    loadInputs('wts',WTS_IDS);",
    done: "loadInputs('wts',WTS_IDS);" },
  { id: 'H1-calc-save', spec: 'H1', region: regionCalc,
    find: '    const ids=' + IDS_OLD + ';\n    saveInputs(\'wts\',ids);',
    replace: "    saveInputs('wts',WTS_IDS);",
    done: "saveInputs('wts',WTS_IDS);" },

  // H2 — markup
  { id: 'H2-pgsub', spec: 'H2', region: regionRender,
    find: "$('pgSub').textContent='Flow assurance — P, T & velocity from wellhead to flare (API RP 14E)';",
    replace: "$('pgSub').textContent='Live 3D process simulation — P, T, levels & velocity from wellhead to gauge tank (API RP 14E)';",
    done: 'Live 3D process simulation' },
  { id: 'H2-viz-skeleton', spec: 'H2', region: regionRender,
    find: '    <div class="card" style="padding:8px"><canvas id="wts_cv" width="1200" height="340" style="width:100%;background:var(--bg0);border-radius:6px"></canvas></div>',
    replace: [
      '    <div class="card wtsl-card" style="padding:8px">',
      '      <div id="wts_viz" class="wtsl-viz" data-mode="2d" data-rp-nosnap>',
      '        <div id="wts_view2d" class="wtsl-view2d"><canvas id="wts_cv" width="1200" height="340" style="width:100%;background:var(--bg0);border-radius:6px"></canvas></div>',
      '      </div>',
      '    </div>'].join('\n'),
    done: 'id="wts_viz"' },
  { id: 'H2-dynsim-card', spec: 'H2/D28/K24', region: regionRender,
    find: [
      '      <div class="card"><div class="card-title">Separator</div><div class="fg">',
      '        <div class="fg-item"><label>Operating Pressure (psig)</label><input type="number" id="wts_Psep" value="150"></div>',
      '      </div></div>'].join('\n'),
    replace: [
      '      <div class="card"><div class="card-title">Separator</div><div class="fg">',
      '        <div class="fg-item"><label>Operating Pressure (psig)</label><input type="number" id="wts_Psep" value="150"></div>',
      '      </div></div>',
      '      <div class="card"><div class="card-title">Dynamic Simulation</div><div class="fg">',
      '        <div class="fg-item"><label>Separator ID (in)</label><input type="number" id="wts_sepID" value="36" min="12" max="96"></div>',
      '        <div class="fg-item"><label>Separator Length S/S (ft)</label><input type="number" id="wts_sepL" value="10" min="4" max="40"></div>',
      '        <div class="fg-item"><label>Surge Tank Pressure (psig, 0&ndash;30)</label><input type="number" id="wts_Psurge" value="25" min="0" max="30"></div>',
      '        <div class="fg-item"><label>Surge Tank Capacity (bbl)</label><input type="number" id="wts_surgeCap" value="100" min="10" max="500"></div>',
      '        <div class="fg-item"><label>Gauge Tank Compartment (bbl)</label><input type="number" id="wts_gtCap" value="100" min="10" max="500"></div>',
      '      </div></div>'].join('\n'),
    done: 'id="wts_sepID"' },
  { id: 'H2-seg-rows', spec: 'H2/D36', region: regionRender,
    find: [
      "        ${sR(1,'WH &rarr; SSV','4','50')}",
      "        ${sR(2,'SSV &rarr; Choke','4','100')}",
      "        ${sR(3,'Choke &rarr; Heater','4','200')}",
      "        ${sR(4,'Heater &rarr; Sep','4','100')}",
      "        ${sR(5,'Sep &rarr; Flare','6','300')}",
      "        ${sR(6,'Surge &rarr; Atm Tank','3','80')}"].join('\n'),
    replace: [
      "        ${sR(1,'WH &rarr; ESD','4','50')}",
      "        ${sR(2,'ESD &rarr; Choke','4','100')}",
      "        ${sR(3,'Choke &rarr; Heater','6','200')}",
      "        ${sR(4,'Heater &rarr; Sep','6','100')}",
      "        ${sR(5,'Sep &rarr; Flare','6','300')}",
      "        ${sR(6,'Surge &rarr; Gauge Tank','3','80')}"].join('\n'),
    done: "sR(6,'Surge &rarr; Gauge Tank'" },

  // H3 — binding sweep skips HMI controls; mount the live view after the first calc
  { id: 'H3-bind-mount', spec: 'H3', region: regionRender,
    find: "    setTimeout(()=>{document.querySelectorAll('#pgBody input,#pgBody select').forEach(el=>{el.addEventListener('input',wtsAC);el.addEventListener('change',calcWTS);});calcWTS();},50);",
    replace: [
      "    setTimeout(()=>{document.querySelectorAll('#pgBody input:not([data-wts-ui]),#pgBody select:not([data-wts-ui])').forEach(el=>{el.addEventListener('input',wtsAC);el.addEventListener('change',calcWTS);});calcWTS();",
      "        try{ if(window.WTS_live) window.WTS_live.mount($('wts_viz')); }catch(e){ console.warn('[WTS] live view failed',e); }",
      '    },50);'].join('\n'),
    done: 'window.WTS_live.mount(' },

  // H4b — new dynamic-simulation inputs (clamped) + flare header constant
  { id: 'H4b-new-inputs', spec: 'H4b/K24', region: regionCalc,
    find: "    const Cfac=gv('wts_Cfac')||100,epsIn=gv('wts_eps')||0.0018;",
    replace: [
      "    const Cfac=gv('wts_Cfac')||100,epsIn=gv('wts_eps')||0.0018;",
      '    // Dynamic-simulation inputs (imperial-only, not in the units MANIFEST — D28)',
      '    const wtsClamp=(v,a,b)=>Math.min(b,Math.max(a,v));',
      "    const PsurgeRaw=isFinite(gv('wts_Psurge'))?gv('wts_Psurge'):25;",
      "    const sepID=wtsClamp(gv('wts_sepID')||36,12,96),sepL=wtsClamp(gv('wts_sepL')||10,4,40),",
      '          Psurge=wtsClamp(PsurgeRaw,0,Math.min(30,Math.max(0,Psep-10))),',
      "          surgeCap=wtsClamp(gv('wts_surgeCap')||100,10,500),gtCap=wtsClamp(gv('wts_gtCap')||100,10,500);",
      '    const P_FLARE_HDR=5;   // psig, flare header downstream of PCV-101 (= sim cfg.sep.pcv.P2_psig)'].join('\n'),
    done: 'const P_FLARE_HDR=5;' },

  // H8 — calc coherence: choke outlet solved from the separator side (D36)
  { id: 'H8-choke-walk', spec: 'H8/D36/K5', region: regionCalc,
    from: '    let Pco_psia, regime, flowLimited=false;',
    to: '    // Seg 5: Separator',
    mustContain: 'const cvDrop=Parr-Psep;',
    replace: [
      '    // ── Choke outlet set by the separator side (backward walk); regime from the pressure ratio ──',
      '    const CpM=mdG*0.56+mdO*0.50+mdW*1.0;',
      '    const wJT=CpM>0?mdG*0.56/CpM:1;                            // gas share of mixture heat capacity',
      '    const jtOf=dp=>Math.min(150,0.07*wJT*Math.max(dp,0));      // °F; ≈7 °F/100 psi for gas, damped by liquids',
      '    let Pco=Psep+5,Tco=Tci,s3,s4,Phi,Thi,Pho,Tho;',
      '    for(let it=0;it<6;it++){                                    // fixed point: arrival pressure → Psep',
      '        Tco=Tci-jtOf(Pci-Pco);',
      "        s3=seg(3,Pco,Tco,'multi');Phi=s3.Pout;Thi=s3.Tout;",
      '        Pho=Phi-5;Tho=bypass?Thi:Math.max(Thtr,Thi);',
      "        s4=seg(4,Pho,Tho,'multi');",
      '        Pco+=Psep-s4.Pout;',
      '    }',
      '    Tco=Tci-jtOf(Pci-Pco);',
      "    s3=seg(3,Pco,Tco,'multi');Phi=s3.Pout;Thi=s3.Tout;Pho=Phi-5;Tho=bypass?Thi:Math.max(Thtr,Thi);s4=seg(4,Pho,Tho,'multi');",
      '    const Pco_psia=Pco+14.696,pratio=Pco_psia/P1a;',
      '    let regime,flowLimited=false,Qcap=Q_crit_max;',
      "    if(Qg<=0)regime='No Flow';",
      "    else if(Pco>=Pci-0.5){regime='No Flow';flowLimited=true;Qcap=0;}",
      "    else if(pratio<=rCrit){regime='Critical';flowLimited=Q_mscfd>Q_crit_max*1.01;}",
      "    else{regime='Subcritical';Qcap=preFac*Math.sqrt(fInner(pratio));flowLimited=Q_mscfd>Qcap*1.01;}",
      '    const dPchk=Pci-Pco, dTjt=jtOf(dPchk);',
      '    const dTh=Tho-Thi;',
      '    const CpG=0.56,CpO=0.50,CpW=1.0;',
      '    const Qdot=(mdG*CpG+mdO*CpO+mdW*CpW)*Math.max(dTh,0)*3600;',
      '    const Qfired=htrEff>0?Qdot/htrEff:0;',
      '    const QMM=Qfired/1e6;',
      '    const Tsi=s4.Tout,Parr=s4.Pout;',
      ''].join('\n'),
    done: 'const jtOf=dp=>' },

  // H4e — surge pressure on seg 6 and the Surge node; flare node = header (D32/D36/K38)
  { id: 'H4e-seg6', spec: 'H4e/D32', region: regionCalc,
    find: "    const s6=seg(6,0,Tsi,'liquid');",
    replace: "    const s6=seg(6,Psurge,Tsi,'liquid');",
    done: "seg(6,Psurge,Tsi,'liquid')" },
  { id: 'H4e-node-choke', spec: 'H4e/H8', region: regionCalc,
    find: "        {nm:'Choke',P:Pco,T:Tco,th:Thyd(Math.max(Pco+14.696,15)),regime,bean,Pci,Qmax:Q_crit_max},",
    replace: "        {nm:'Choke',P:Pco,T:Tco,th:Thyd(Math.max(Pco+14.696,15)),regime,bean,Pci,Qmax:Qcap,flowLimited},",
    done: 'Pci,Qmax:Qcap,flowLimited}' },
  { id: 'H4e-node-flare', spec: 'H4e/D36', region: regionCalc,
    find: "        {nm:'Flare',P:Math.max(s5.Pout,0),T:s5.Tout,th:Thyd(Math.max(s5.Pout,0)+14.696)},",
    replace: "        {nm:'Flare',P:P_FLARE_HDR,T:s5.Tout,th:Thyd(P_FLARE_HDR+14.696)},",
    done: "{nm:'Flare',P:P_FLARE_HDR" },
  { id: 'H4e-node-surge', spec: 'H4e/D32', region: regionCalc,
    find: "        {nm:'Surge Tank',P:0,T:Tsi,th:Thyd(14.696)},",
    replace: "        {nm:'Surge Tank',P:Psurge,T:Tsi,th:Thyd(Psurge+14.696)},",
    done: "{nm:'Surge Tank',P:Psurge" },
  { id: 'H3.1-segnames', spec: '§3.1', region: regionCalc,
    find: "    const segNm=['WH\\u2192SSV','SSV\\u2192Choke','Choke\\u2192Heater','Heater\\u2192Sep','Sep\\u2192Flare','Surge\\u2192Atm Tank'];",
    replace: "    const segNm=['WH\\u2192ESD','ESD\\u2192Choke','Choke\\u2192Heater','Heater\\u2192Sep','Sep\\u2192Flare','Surge\\u2192Gauge Tank'];",
    done: "'Surge\\u2192Gauge Tank'" },

  // H4d — Critical is purple info; red only when flow-limited (D13)
  { id: 'H4d-regime-colour', spec: 'H4d/D13', region: regionCalc,
    find: "        regEl.style.color=regime==='Critical'?'var(--red)':regime==='Subcritical'?'var(--green)':'var(--text3)';",
    replace: "        regEl.style.color=flowLimited?'var(--red)':regime==='Critical'?'var(--purple)':regime==='Subcritical'?'var(--green)':'var(--text3)';",
    done: "regEl.style.color=flowLimited?'var(--red)'" },

  // H4c — warnings
  { id: 'H4c-flowlimited-qcap', spec: 'H4c/H8', region: regionCalc,
    find: 'at Cd=${Cd_ck} can only pass ${fmt(Q_crit_max/1000,2)} MMSCFD;',
    replace: 'at Cd=${Cd_ck} can only pass ${fmt(Qcap/1000,2)} MMSCFD;',
    done: 'can only pass ${fmt(Qcap/1000,2)} MMSCFD;' },
  { id: 'H4c-noflow-surge-warns', spec: 'H4c/K24', region: regionCalc,
    find: "    if(cvDrop<-5)warns.push({t:'error',m:`Separator pressure too high — arriving ${fmt(Parr,0)} psig &lt; sep operating ${Psep} psig`});",
    replace: [
      "    if(regime==='No Flow'&&Qg>0)warns.push({t:'error',m:'Separator back-pressure exceeds the choke upstream pressure — no flow possible'});",
      "    if(PsurgeRaw>30)warns.push({t:'warn',m:'Surge tank pressure limited to 30 psig (atmospheric-rated surge tank)'});",
      "    if(PsurgeRaw>Psep-10)warns.push({t:'warn',m:'Surge tank pressure too close to separator pressure — liquids cannot dump'});"].join('\n'),
    done: 'Separator back-pressure exceeds the choke upstream pressure' },
  { id: 'H4c-warnbox', spec: 'H4c/K28', region: regionCalc,
    find: [
      "                const c=w.t==='error'?'var(--red)':w.t==='warn'?'var(--yellow)':'var(--blue)';",
      "                const ic=w.t==='error'?'&#9888;':w.t==='warn'?'&#9888;':'&#10052;';",
      '                return `<div style="padding:6px 12px;background:rgba(248,81,73,0.08);border-left:3px solid ${c};'].join('\n'),
    replace: [
      "                const c=w.t==='error'?'var(--red)':w.t==='warn'?'var(--yellow)':w.t==='info'?'var(--blue)':'var(--text2)';",
      "                const ic=w.t==='error'||w.t==='warn'?'&#9888;':w.t==='info'?'&#10052;':'&#8505;';",
      "                const bg=w.t==='error'?'rgba(248,81,73,.08)':w.t==='warn'?'rgba(210,153,34,.08)':w.t==='info'?'rgba(88,166,255,.08)':'rgba(139,148,158,.08)';",
      '                return `<div style="padding:6px 12px;background:${bg};border-left:3px solid ${c};'].join('\n'),
    done: "w.t==='info'?'rgba(88,166,255,.08)'" },

  // H4e/D27 — node-table display names only (internal nm unchanged)
  { id: 'D27-node-table-labels', spec: 'D27', region: regionCalc,
    find: '<tr><td style="font-weight:600">${nd.nm}</td>',
    replace: "<tr><td style=\"font-weight:600\">${nd.nm==='SSV'?'ESD / SSV':nd.nm==='Flare'?'Flare (header, d/s PCV-101)':nd.nm==='Atm Tank'?'Gauge Tank':nd.nm}</td>",
    done: "nd.nm==='SSV'?'ESD / SSV'" },

  // H4d — choke results rows
  { id: 'H4d-row-downstream', spec: 'H4d', region: regionCalc,
    find: '<span class="rl">Downstream P (computed)</span>',
    replace: '<span class="rl">Downstream P (separator back-pressure)</span>',
    done: 'Downstream P (separator back-pressure)' },
  { id: 'H4d-row-regime', spec: 'H4d/D13', region: regionCalc,
    find: "<span class=\"rl\">Flow Regime</span><span class=\"rv\" style=\"color:${regime==='Critical'?'var(--red)':'var(--green)'};font-weight:700\">${regime}</span>",
    replace: "<span class=\"rl\">Flow Regime</span><span class=\"rv\" style=\"color:${flowLimited?'var(--red)':regime==='Critical'?'var(--purple)':regime==='Subcritical'?'var(--green)':'var(--text3)'};font-weight:700\">${regime}${flowLimited?' (flow-limited)':''}</span>",
    done: "${regime}${flowLimited?' (flow-limited)':''}" },
  { id: 'H4d-row-maxrate', spec: 'H4d/H8', region: regionCalc,
    find: '<span class="rl">Max Rate (Critical)</span><span class="rv">${fmt(Q_crit_max/1000,2)} MMSCFD</span>',
    replace: '<span class="rl">Max Rate at this ratio</span><span class="rv">${fmt(Qcap/1000,2)} MMSCFD</span>',
    done: 'Max Rate at this ratio' },
  { id: 'H4d-row-jt', spec: 'H4d/H8', region: regionCalc,
    find: '<span class="rl">J-T Cooling</span><span class="rv">${fmt(7*dPchk/1000,1)} &deg;F</span>',
    replace: '<span class="rl">J-T Cooling</span><span class="rv">${fmt(dTjt,1)} &deg;F</span>',
    done: '${fmt(dTjt,1)} &deg;F' },

  // §3.1 / L2 — extend the existing publish: WTS_state.flow v1 + WTS_lastCalc.flow (additive)
  { id: 'S3.1-publish', spec: '§3.1/D14/L2', region: regionCalc,
    from: '    window.WTS_lastCalc={nodes,segs,segNames:segNm,regime,flowLimited,',
    to: "try{document.dispatchEvent(new CustomEvent('wts:calc',{detail:window.WTS_lastCalc}));}catch(_){}",
    toInclusive: true,
    replace: [
      '    // Flow contract v1 (plain JSON; replaced on every calc, never mutated after publishing).',
      '    let flow=null;',
      '    try{',
      "        const NODE_IDS=['wellhead','esd','choke','heater','separator','flare','surge','gauge'];",
      "        const SEG_META=[['wh_esd','wellhead','esd'],['esd_choke','esd','choke'],['choke_heater','choke','heater'],",
      "                        ['heater_sep','heater','separator'],['sep_flare','separator','flare'],['surge_gauge','surge','gauge']];",
      '        const GW=window; GW.WTS_state=GW.WTS_state||{};',
      '        const prevSeq=(GW.WTS_state.flow&&GW.WTS_state.flow.seq)||0;',
      "        const stripHtml=m=>String(m).replace(/<[^>]*>/g,'').replace(/&deg;/g,'\\u00b0').replace(/&lt;/g,'<').replace(/&gt;/g,'>')",
      "                           .replace(/&Delta;/g,'\\u0394').replace(/&mdash;/g,'\\u2014').replace(/&amp;/g,'&');",
      '        flow={',
      '          v:1, seq:prevSeq+1, ts:Date.now(),',
      '          wellheadPressure:Pwh, wellheadTemp:Twh, gasRate:Qg, oilRate:Qo, waterRate:Qw, chokeBean:bean, separatorPressure:Psep,',
      '          inputs:{Pwh,Twh,Qg,Qo,Qw,SGg,API,bean,Cd:Cd_ck,Thtr,htrEff,bypass,Psep,Cfac,eps:epsIn},',
      '          fluid:{Mg,SGo,rhoOil,rhoWat,rhoGstd,Ppc,Tpc},',
      '          choke:{regime,flowLimited,QmaxMMscfd:Qcap/1000,QcritMMscfd:Q_crit_max/1000,Pin:Pci,Pout:Pco,ratio:pratio,rCrit,',
      '                 dP:dPchk,dTjt,wJT},',
      '          heater:{bypass,dutyMMBtuHr:QMM,processMMBtuHr:Qdot/1e6,Tin:Thi,Tout:Tho},',
      '          sep:{arrivalP:Parr,inletDP:Parr-Psep},',
      '          flareHdrP:P_FLARE_HDR,',
      '          nodes:nodes.map((n,i)=>Object.assign({id:NODE_IDS[i]},n)),',
      '          segs:segs.map((s,i)=>Object.assign({id:SEG_META[i][0],from:SEG_META[i][1],to:SEG_META[i][2],label:segNm[i]},s)),',
      '          warnings:warns.map(w=>({t:w.t,m:stripHtml(w.m)})),',
      '          sim:{sepID_in:sepID,sepLss_ft:sepL,surgeP_psig:Psurge,surgeCap_bbl:surgeCap,gaugeCap_bbl:gtCap}',
      '        };',
      '        GW.WTS_state.flow=flow;',
      '        GW.WTS_state.nodes=nodes.map((n,i)=>{const vi=[0,1,2,3,4,null,5,null][i];',
      "          return {label:n.nm==='Atm Tank'?'Gauge Tank':n.nm==='SSV'?'ESD Valve (SSV)':n.nm==='Flare'?'Flare (header)':n.nm,name:n.nm,",
      '                  pressure:n.P,temperature:n.T,velocity:vi==null?null:segs[vi].vel};});',
      '        GW.WTS_state.gasSG=SGg; GW.WTS_state.gasRate=Qg; GW.WTS_state.gasTemp_F=Twh;',
      "    }catch(e){ flow=null; console.warn('[WTS] publish',e); }",
      '    // Publish the solved flow path so other modules (Pipe Service Life,',
      '    // live 3D view, reports) can consume it without re-running the walk.',
      '    window.WTS_lastCalc={nodes,segs,segNames:segNm,regime,flowLimited,',
      '        inputs:{Pwh,Twh,Qg,Qo,Qw,SGg,API,bean,Cd:Cd_ck,Thtr,htrEff,bypass,Psep,Cfac,eps:epsIn},',
      '        heater:{Tin:Thi,Tout:Tho,dutyMMBtu:QMM},choke:{Pin:Pci,Pout:Pco,ratio:pratio,Qmax:Qcap,dTjt},',
      '        flow};                                                      // additive fields only',
      "    try{document.dispatchEvent(new CustomEvent('wts:calc',{detail:window.WTS_lastCalc}));}catch(_){}"].join('\n'),
    done: 'GW.WTS_state.flow=flow;' },

  // H5 — DPR-aware wtsDrawDiag with a shared logical layout; labels; purple Critical
  { id: 'H5-layout-const', spec: 'H5/D26', region: regionWTS,
    find: 'function wtsDrawDiag(nodes,segs){',
    replace: 'const WTS_DIAG_LAYOUT={W:1200,H:340,tx:[85,230,380,535,695,950],cy:130,bx:[695,1000],by:245,cl:[18,16,20,27,30,10],strip:{x:20,y:215,w:600,h:103}};\nfunction wtsDrawDiag(nodes,segs){',
    done: 'const WTS_DIAG_LAYOUT=' },
  { id: 'H5-transform', spec: 'H5/D26', region: regionDiag,
    find: '    const W=cv.width,H=cv.height;\n    ctx.clearRect(0,0,W,H);',
    replace: '    const L=WTS_DIAG_LAYOUT,W=L.W,H=L.H;\n    ctx.setTransform(cv.width/W,0,0,cv.height/H,0,0);\n    ctx.clearRect(0,0,W,H);',
    done: 'ctx.setTransform(cv.width/W,0,0,cv.height/H,0,0);' },
  { id: 'H5-layout-use', spec: 'H5', region: regionDiag,
    find: [
      '    const tx=[85,230,380,535,695,950];',
      '    const cy=130;',
      '    // Bottom-row tank positions',
      '    const bx=[695,1000], by=cy+115;',
      '    // Equipment half-widths for pipe clearance',
      '    const cl=[18,16,20,27,30,10];'].join('\n'),
    replace: [
      '    // Top-row node x positions, bottom-row tanks and pipe clearances (WTS_DIAG_LAYOUT)',
      '    const tx=L.tx, cy=L.cy, bx=L.bx, by=L.by, cl=L.cl;'].join('\n'),
    done: 'const tx=L.tx, cy=L.cy, bx=L.bx, by=L.by, cl=L.cl;' },
  { id: 'H5-choke-call', spec: 'H5/D13', region: regionDiag,
    find: 'wtsEqChk(ctx,tx[2],cy,nodes[2].regime);',
    replace: 'wtsEqChk(ctx,tx[2],cy,nodes[2].regime,nodes[2].flowLimited);',
    done: 'nodes[2].regime,nodes[2].flowLimited);' },
  { id: 'H5-tlabels', spec: 'H5/D27', region: regionDiag,
    find: "const tlabels=['Wellhead','SSV','Choke','Heater','Separator','Flare'];",
    replace: "const tlabels=['Wellhead','ESD / SSV','Choke','Heater','Separator','Flare'];",
    done: "'ESD / SSV','Choke'" },
  { id: 'H5-gauge-label', spec: 'H5/D27', region: regionDiag,
    find: "ctx.fillText('Atm Tank',bx[1],by+38);",
    replace: "ctx.fillText('Gauge Tank',bx[1],by+38);",
    done: "ctx.fillText('Gauge Tank',bx[1],by+38);" },
  { id: 'H5-regime-text', spec: 'H5/D13', region: regionDiag,
    find: "ctx.fillStyle=nodes[2].regime==='Critical'?'#f85149':'#3fb950';",
    replace: "ctx.fillStyle=nodes[2].flowLimited?'#f85149':nodes[2].regime==='Critical'?'#bc8cff':'#3fb950';",
    done: "nodes[2].flowLimited?'#f85149':nodes[2].regime==='Critical'?'#bc8cff'" },
  { id: 'H5-eqchk', spec: 'H5/D13', region: regionDiag,
    find: "function wtsEqChk(ctx,x,y,regime){\n    const c=regime==='Critical'?'#f85149':'#d29922';",
    replace: "function wtsEqChk(ctx,x,y,regime,limited){\n    const c=limited?'#f85149':regime==='Critical'?'#bc8cff':'#d29922';",
    done: 'function wtsEqChk(ctx,x,y,regime,limited){' },
  { id: 'H5-bridge', spec: 'H5', region: regionDiag,
    find: '// ── Initial render ──',
    replace: '// Bridges for the Round-7 live view (38-wts-live draws the live 2D through these).\nwindow.wtsDrawDiag=wtsDrawDiag; window.WTS_DIAG_LAYOUT=WTS_DIAG_LAYOUT;\n\n// ── Initial render ──',
    done: 'window.wtsDrawDiag=wtsDrawDiag;' },

  // H6 — GA_EVENTS documentation rows
  { id: 'H6-ga-events', spec: 'H6', region: regionGA,
    find: '\n];',
    replace: [
      '',
      "    { name:'wts_viz_mode',        trigger:'Well Test Simulator live view switched to 3D or 2D (or 3D finished loading)',",
      "      params:'mode (3d | 2d)' },",
      "    { name:'wts_viz_fallback',    trigger:'Live 3D view fell back to the 2D schematic',",
      "      params:'reason' },",
      "    { name:'wts_camera_view',     trigger:'Live 3D camera preset chosen (View menu or keys 0-5)',",
      "      params:'view' },",
      "    { name:'wts_sim_speed',       trigger:'Live simulation speed changed',",
      "      params:'speed (1 | 10 | 60 | 600)' },",
      "    { name:'wts_esd',             trigger:'Live simulation ESD tripped or reset by the user',",
      "      params:'action (trip | reset)' },",
      "    { name:'wts_alarm_ack',       trigger:'Live simulation alarms acknowledged',",
      "      params:'count' },",
      "    { name:'wts_fault',           trigger:'Live simulation scenario fault toggled',",
      "      params:'id, on' },",
      '];'].join('\n'),
    done: "name:'wts_viz_mode'" },

  // H7 — report exclusions (D39)
  { id: 'H7a-rp-skip', spec: 'H7a/K29', region: regionCollect,
    find: "    root.querySelectorAll('.fg-item, table, .rrow, .kpi, canvas, svg, input, select, textarea, div, p').forEach(el => {\n        if(!_isShown(el)) return;",
    replace: "    root.querySelectorAll('.fg-item, table, .rrow, .kpi, canvas, svg, input, select, textarea, div, p').forEach(el => {\n        if(el.closest('.rp-skip')) return;\n        if(!_isShown(el)) return;",
    done: "if(el.closest('.rp-skip')) return;\n        if(!_isShown(el)) return;" },
  { id: 'H7b-nosnap', spec: 'H7b/K29', region: regionSnap,
    find: "    if(!tg || !tg.closest || !tg.closest('#pgBody')) return;",
    replace: "    if(!tg || !tg.closest || !tg.closest('#pgBody')) return;\n    if(tg.closest('[data-rp-nosnap]')) return;",
    done: "if(tg.closest('[data-rp-nosnap]')) return;" },
];

// ── Engine ─────────────────────────────────────────────────────────
function countOf(hay, needle) {
  let n = 0, i = hay.indexOf(needle);
  while (i !== -1) { n++; i = hay.indexOf(needle, i + needle.length); }
  return n;
}
function withEol(s, eol) { return eol === '\n' ? s : s.replace(/\r?\n/g, eol); }

// Returns { out, report:[{id, spec, status:'applied'|'already'|'ok'|'missing'|'ambiguous'|'no-region'|'bad-range', detail}] }
function patch(html, opts) {
  opts = opts || {};
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  let t = html;
  const report = [];
  for (const E of EDITS) {
    const R = E.region(t);
    const rec = { id: E.id, spec: E.spec, status: '', detail: '' };
    report.push(rec);
    if (!R) { rec.status = 'no-region'; rec.detail = 'region not found'; continue; }
    const reg = t.slice(R[0], R[1]);
    // Try the host EOL first, then LF (mixed-ending safety).
    const eols = eol === '\n' ? ['\n'] : [eol, '\n'];
    let doneHit = false;
    for (const e of eols) if (reg.indexOf(withEol(E.done, e)) !== -1) { doneHit = true; break; }
    if (doneHit) { rec.status = 'already'; continue; }
    let applied = false;
    for (const e of eols) {
      if (E.find != null) {
        const f = withEol(E.find, e);
        const n = countOf(reg, f);
        if (n === 0) continue;
        if (n > 1) { rec.status = 'ambiguous'; rec.detail = n + ' matches'; applied = true; break; }
        const at = R[0] + reg.indexOf(f);
        if (!opts.dryRun) t = t.slice(0, at) + withEol(E.replace, e) + t.slice(at + f.length);
        rec.status = opts.dryRun ? 'ok' : 'applied';
        applied = true; break;
      } else {
        const fr = withEol(E.from, e), to = withEol(E.to, e);
        const nf = countOf(reg, fr);
        if (nf === 0) continue;
        if (nf > 1) { rec.status = 'ambiguous'; rec.detail = nf + ' start matches'; applied = true; break; }
        const a = reg.indexOf(fr);
        const b = reg.indexOf(to, a + fr.length);
        if (b < 0) { rec.status = 'bad-range'; rec.detail = 'end anchor not found after start'; applied = true; break; }
        const bEnd = E.toInclusive ? b + to.length : b;
        const body = reg.slice(a, bEnd);
        if (E.mustContain && body.indexOf(withEol(E.mustContain, e)) === -1) {
          rec.status = 'bad-range'; rec.detail = 'range lacks "' + E.mustContain + '"'; applied = true; break;
        }
        if (!opts.dryRun) t = t.slice(0, R[0] + a) + withEol(E.replace, e) + t.slice(R[0] + bEnd);
        rec.status = opts.dryRun ? 'ok' : 'applied';
        rec.detail = (body.split('\n').length) + ' lines replaced';
        applied = true; break;
      }
    }
    if (!applied) { rec.status = 'missing'; rec.detail = 'anchor not found'; }
  }
  return { out: t, report };
}

const USAGE = [
  'Usage (from the repo root):',
  '  node prism-build/wts-host-patch.js --check                 dry run: report every anchor (default action)',
  '  node prism-build/wts-host-patch.js --apply                 patch well-testing-app.html IN PLACE (writes a .bak first)',
  '  node prism-build/wts-host-patch.js --file a.html --out b.html   patch a.html into b.html (a.html untouched)',
  '  node prism-build/wts-host-patch.js --file a.html --apply   patch a.html in place (writes a.html.bak first)',
  '  add --json for a machine-readable report;  --help / -h prints this text',
  '',
  'Nothing is ever written without --apply or --out. Unknown flags exit with code 2.',
  'Exit code: 0 when every edit is applied/applicable/already present; 1 on anchor problems; 2 on bad usage.'
].join('\n');

function parseArgs(argv) {
  const o = { check: false, apply: false, json: false, help: false, file: null, out: null, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check' || a === '--dry-run') o.check = true;
    else if (a === '--apply' || a === '--write') o.apply = true;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--file' || a === '--out') {
      const v = argv[i + 1];
      if (v == null || /^-/.test(v)) { o.error = a + ' needs a path'; break; }
      o[a.slice(2)] = v; i++;
    } else { o.error = 'unknown argument "' + a + '"'; break; }
  }
  if (!o.error && o.check && (o.apply || o.out)) o.error = '--check cannot be combined with --apply/--out';
  return o;
}

function main(argv) {
  argv = argv || process.argv.slice(2);
  const o = parseArgs(argv);
  if (o.help) { console.log(USAGE); return; }
  if (o.error) { console.error('[wts-host-patch] ' + o.error + '\n\n' + USAGE); process.exitCode = 2; return; }
  const json = o.json;
  const file = o.file ? path.resolve(o.file) : DEFAULT_HTML;
  const outFile = o.out ? path.resolve(o.out) : file;
  // Write only on an explicit request: --apply (in place) or --out (another file).
  // --out pointing at the input itself still needs --apply.
  if (o.out && outFile === file && !o.apply) {
    console.error('[wts-host-patch] --out equals --file; pass --apply to patch in place\n\n' + USAGE);
    process.exitCode = 2; return;
  }
  const check = !(o.apply || o.out);
  const html = fs.readFileSync(file, 'utf8');
  const { out, report } = patch(html, { dryRun: check });
  const bad = report.filter(r => !/^(applied|already|ok)$/.test(r.status));
  if (json) console.log(JSON.stringify({ file, check, report }, null, 1));
  else {
    console.log('[wts-host-patch] ' + (check ? 'CHECK (dry run) ' : '') + file);
    for (const r of report) console.log('  ' + r.status.padEnd(10) + r.id.padEnd(26) + (r.spec || '').padEnd(14) + (r.detail || ''));
    const n = s => report.filter(r => r.status === s).length;
    console.log('  → ' + report.length + ' edits: ' + n('ok') + ' applicable, ' + n('applied') + ' applied, ' + n('already') + ' already present, ' + bad.length + ' problem(s)');
  }
  if (bad.length) { process.exitCode = 1; return; }
  if (!check) {
    if (out !== html || outFile !== file) {
      if (outFile === file) {                    // in-place: keep a backup of the original
        fs.writeFileSync(file + '.bak', html, 'utf8');
        if (!json) console.log('[ok] backup ' + file + '.bak');
      }
      fs.writeFileSync(outFile, out, 'utf8');
      if (!json) console.log('[ok] wrote ' + outFile);
    } else if (!json) console.log('[ok] nothing to change');
  }
}

module.exports = { EDITS, patch, main, parseArgs, USAGE };
if (require.main === module) main();
