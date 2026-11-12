// 49-calc-help-print.js — printable User Guide (HELP-GUIDE-PLAN §5): renderBook, Print menu, iOS reader. Cap 15 kB.
// Loads before 49-calc-help.js, merges into WTS_help; no timers. Links print "see Chapter N.M": no engine prints
// target-counter() pages. Adds M.files {file:{w,h,h8}} (read by the page) to the 48 manifest's rows.
(function(){
'use strict';
var G=(typeof window!=='undefined')?window:globalThis,H=G.WTS_help=G.WTS_help||{};
var SITE='welltest.h2oil.co.uk',BOOK='Well Testing Suite — User Guide',CH='Chapter ',IMG='help/img/',AP='Appendix ',UG='help/user-guide.html',SC=/^(card|worksheet):(.+)$/;
var LT={start:'Getting started',tasks:'How do I…',course:'Well Test Simulator course',wpcourse:'Well performance course',scenarios:'Field scenarios'};
var KIND={task:'start',tasks:'start',start:'start',fs:'fs',scenarios:'fs',course:'course',wpcourse:'wpcourse',glossary:'glossary',faq:'faq'};
var KEYS=[['F1','Help for this page'],['/','Help: search box'],['↑ ↓ Enter Esc','Help search results'],['?','Simulator: keyboard shortcuts']];
var arr=v=>Array.isArray(v)?v:v==null||v===''?[]:[v],C=()=>H.load(),esc=s=>H.esc(s),md=(s,o)=>H.md(s,o);
var byId=id=>typeof document!=='undefined'?document.getElementById(id):null;
var pt=s=>String(s||'').replace(/\*\*([^*]+)\*\*/g,'$1').replace(/`([^`]+)`/g,'$1'),nr=r=>r==='dca'||r==='pta'?'prism':r,ws=o=>Object.assign({},o,{worksheet:true}),EX=k=>H.exercises?H.exercises(k):C().course,EK=id=>H.exerciseKind?H.exerciseKind(id):'course';
var go=(r,l)=>'<button type="button" class="help-a" data-help-go="'+r+'">'+l+'</button>';
var note=t=>'<p class="help-note">'+t+' not in this build yet.</p>';
var lines=n=>new Array(n+1).join('<div class="bk-line"></div>');
var list=(k,o)=>String(H.renderList(k,o)).replace(/^<h2[^>]*>[\s\S]*?<\/h2>/,'');
var chap=(id,t,b)=>'<section class="bk-ch" id="'+id+'"><h2>'+esc(t)+'</h2>\n'+b+'</section>\n';
var tb=(h,rows)=>'<table><tr><th>'+h.join('</th><th>')+'</th></tr>'+rows.map(r=>'<tr><td>'+r.join('</td><td>')+'</td></tr>').join('')+'</table>';
var rel=()=>(typeof RELEASE_NOTES!=='undefined'&&RELEASE_NOTES[0])||{ver:G.WTS_appVersion?G.WTS_appVersion():''};
var when=R=>/^\d{4}-\d\d-\d\d$/.test(R.date||'')?' · '+R.date:'';
function files(){
  var M=G.WTS_helpManifest||{},out={},D=M.data||{};
  if(M.files&&!Array.isArray(M.files))return Object.assign(out,M.files);
  Object.keys(D).forEach(f=>String(D[f]).split(',').forEach(r=>{var p=r.split(' ');if(p[3])out[f+'/'+p[0]+'.webp']={w:+p[1],h:+p[2],h8:p[3]};}));
  return out;
}
if(G.WTS_helpManifest&&!G.WTS_helpManifest.files)G.WTS_helpManifest.files=files();
function withFiles(F,fn){var M=G.WTS_helpManifest;G.WTS_helpManifest={files:F};try{return fn();}finally{G.WTS_helpManifest=M;}}
// chapters (start, groups, simulator, scenarios), numbers N.M, link targets
function plan(){
  var c=C(),P={ch:[],x:{},num:{}},n=0;
  var ch=(kind,t,e)=>{var o=Object.assign({kind:kind,t:t,n:++n,id:'bk-ch-'+n,sec:[]},e);P.ch.push(o);P.x[kind]=[CH+o.n,o.id];return o;};
  var num=(o,r,k)=>{var id='help-'+r+'-top';P.num[id]=k;o.sec.push([id,k+' '+H.titleOf(r)]);P.x[r]=[CH+k,id];};
  ch('start',LT.start);
  H.sidebarGroups().forEach(g=>{
    var rs=g.routes.filter(r=>c.guides[r]&&r!=='wts');
    if(g.label!=='Other'||rs.length){var o=ch('group',g.label,{routes:rs,wts:!!c.guides.wts&&g.routes.indexOf('wts')>-1});rs.forEach((r,i)=>num(o,r,o.n+'.'+(i+1)));}
  });
  var m=ch('course','Well Test Simulator');
  if(c.guides.wts)num(m,'wts',m.n+'.1');
  ch('fs',LT.scenarios);
  if(EX('wpcourse').length)ch('wpcourse',LT.wpcourse);
  P.app=[['A','Standards index'],['B','Glossary'],['C','Keyboard shortcuts'],['D','Troubleshooting and FAQ']];
  P.x.glossary=[AP+'B','bk-app-b'];P.x.faq=[AP+'D','bk-app-d'];
  return P;
}
// [[links]] → "label (see Chapter N.M)"; route#sec → its anchor if in the book
var BTN=/<button type="button" class="help-a" data-help-go="([^"]*)"(?: data-help-sec="([^"]*)")?(?: aria-current="true")?>([\s\S]*?)<\/button>/g;
var links=(h,P,bk)=>h.replace(BTN,(m,r,s,l)=>{
  var t=P.x[r==='course'&&s?EK(s):KIND[r]||nr(r)];
  if(!t)return l;
  var id=s&&KIND[r]?'help-'+({tasks:'task',scenarios:'fs'}[r]||r)+'-'+s:t[1],y=s&&'help-'+nr(r)+'-'+s;
  if(y&&!KIND[r]&&h.indexOf('id="'+y+'"')>-1)id=y;
  return l+' (see '+(bk?'<a class="bk-x" href="#'+id+'">'+t[0]+'</a>':t[0])+')';
});
var numbers=(h,P)=>h.replace(/id="(help-[^"]+-top)" tabindex="-1">/g,(m,id)=>P.num[id]?m+'<span class="bk-n">'+P.num[id]+'</span> ':m);
function chapter(o,x){
  var c=C(),k=o.kind,w=H.titleOf('wts'),b;
  if(k==='start')b=(c.start.length?list('start',x):note('Getting started is'))+(c.tasks.length?'<h3>'+LT.tasks+'</h3>'+list('tasks',x).replace(/<(\/?)h3>/g,'<$1h4>'):'');
  else if(k==='group')b=o.routes.map(r=>H.renderGuide(r,x)).join('\n')+(o.wts?'<p>'+go('wts',esc(w))+'</p>':o.routes.length?'':note('Guides are'));
  else if(k==='course')b=(c.guides.wts?H.renderGuide('wts',x):note('The reference is'))+course(x,k);
  else if(k==='wpcourse')b=(c.guides.wellperf?'<p>'+go('wellperf',esc(H.titleOf('wellperf')))+'</p>':'')+course(x,k);
  else b=c.scenarios.length?list('scenarios',x):note('Field scenarios are');
  return chap(o.id,o.n+' '+o.t,b);
}
// exercises (worksheets), then all answers, then all trainer notes (§5.2)
var TN=[['Duration','duration'],['Fault to inject','fault'],['A good response','good'],['Common mistakes','mistakes',1],['Debrief questions','debrief',1]];
function course(o,k){
  var x=EX(k),ul=l=>'<ul><li>'+l.map(s=>md(s,o)).join('</li><li>')+'</li></ul>',z=(t,f)=>'<h3>'+t+'</h3>'+x.map((e,i)=>'<h4>'+(i+1)+' '+md(e.title,o)+'</h4>'+f(e,e.trainer||{})).join('\n');
  return!x.length?'':'<section class="help-sec" id="bk-'+k+'"><h3>'+LT[k]+'</h3>'+list(k,ws(o))+z('Answers',e=>arr(e.answers).length?ul(arr(e.answers)):'')+
    z('Trainer notes',(e,t)=>TN.map(q=>{var v=arr(t[q[1]]);return!v.length?'':'<p><b>'+q[0]+':</b>'+(q[2]?'</p>'+ul(v):' '+md(v[0],o)+'</p>');}).join(''))+'</section>';
}
function appx(P,o,only){
  var c=C(),S={},out='';
  Object.keys(c.guides).sort().forEach(r=>[c.guides[r]].concat(arr(c.guides[r].parts)).forEach(p=>arr(p&&p.refs).forEach(x=>{
    String(x&&x.std||'').split(/\s+\/\s+|\s*;\s*/).forEach(k=>{k=k.trim();if(k&&(S[k]=S[k]||[]).indexOf(r)<0)S[k].push(r);});
  })));
  var st=Object.keys(S).sort(),B=[st.length?tb(['Standard','Used in'],st.map(k=>[md(k,o),S[k].map(r=>go(r,esc(H.titleOf(r)))).join('; ')])):note('Standards are'),
    Object.keys(c.glossary).length?list('glossary',o):note('The glossary is'),tb(['Key','What it does'],KEYS.map(k=>['<b>'+esc(k[0])+'</b>',esc(k[1])])),
    c.faq.length?list('faq',o):note('The FAQ is')];
  P.app.forEach((a,i)=>{if(!only||only===a[0])out+=chap('bk-app-'+a[0].toLowerCase(),AP+a[0]+' '+a[1],B[i]);});
  return out;
}
function front(P){
  var R=rel(),a=(id,t)=>'<li><a href="#'+id+'">'+esc(t)+'</a>';
  return '<section class="bk-front"><h1>'+BOOK+'</h1><p>Version '+esc(String(R.ver||'').replace(/^v/,'')+when(R))+'</p><p>'+SITE+'</p><nav class="bk-toc"><h2>Contents</h2><ol>\n'+
    P.ch.map(c=>a(c.id,c.n+' '+c.t)+(c.sec.length?'<ol>'+c.sec.map(s=>a(s[0],s[1])+'</li>').join('')+'</ol>':'')+'</li>\n').join('')+
    P.app.map(x=>a('bk-app-'+x[0].toLowerCase(),AP+x[0]+' '+x[1])+'</li>\n').join('')+'</ol></nav></section>\n';
}
// quick card: purpose, steps, inputs, verdicts; at most cardShot
function card(r,o){
  var c=C(),g=c.guides[r],cs=g&&g.cardShot;
  if(!g)return '';
  var st=l=>arr(l).map(s=>typeof s==='string'?s:{t:s.t,shot:cs&&s.shot===cs?cs:undefined});
  c.guides[r]={route:r,title:g.title,units:g.units,notice:g.notice,purpose:g.purpose,steps:st(g.steps),inputs:g.inputs,verdicts:g.verdicts,reviewed:g.reviewed,
    shots:arr(g.shots).filter(s=>cs&&s.id===cs),parts:arr(g.parts).map(p=>({id:p.id,title:p.title,steps:st(p.steps),verdicts:p.verdicts,shots:[]}))};
  try{return '<section class="bk-card"><p class="bk-k">Quick card</p>'+H.renderGuide(r,o)+'</section>';}finally{c.guides[r]=g;}
}
function worksheet(id,o){
  var l=EX(EK(id)),i=l.map(x=>x.id).indexOf(id),x=l[i],q=arr(x&&x.questions);
  return!x?'':'<section class="bk-ws"><p class="bk-k">Trainee worksheet</p>'+H.renderExercise(x,i,ws(o))+
    '<p>Name: ____________________ Date: __________</p><h4>Readings</h4>'+lines(6)+'<h4>Answers</h4>'+(q.length?q.map((y,k)=>'<p><b>Q'+(k+1)+'</b> '+md(y,o)+'</p>'+lines(3)).join(''):lines(6))+'</section>';
}
function body(s,P,o){
  var m=SC.exec(s),r=nr(s),g=P.ch.filter(x=>x.kind==='group'&&x.t===s)[0];
  return s==='all'?front(P)+P.ch.map(x=>chapter(x,o)).join('')+appx(P,o):m?(m[1]==='card'?card:worksheet)(m[2],o):
    C().guides[r]?H.renderGuide(r,o):g?chapter(g,o):'';
}
// scope all|group|route|card:<r>|worksheet:<id>; opts {standalone,imgBase,dataUris,images,units,files}
function renderBook(scope,opts){
  opts=opts||{};
  H.load();
  var P=plan(),o={print:true,units:opts.units||'both',headings:4,imgBase:opts.imgBase,dataUris:opts.dataUris,images:opts.images!==false};
  var sc=String(scope||'all'),one=!!C().guides[nr(sc)]||/^card:/.test(sc);   // one guide: no chapter number in its heading
  var b=links((one?x=>x:numbers)(withFiles(opts.files||files(),()=>body(sc,P,o)),P),P,opts.standalone)
    .replace(/<details class="help-det">/g,'<details class="help-det" open>').replace(/ tabindex="0" role="button"| loading="lazy"| decoding="async"/g,'').replace(/<\/(section|article|p|figure|ul|ol|table|h[2-5])>(?!\n)/g,'</$1>\n');
  if(!opts.standalone)return '<div class="help-book"><style>'+CSS+'</style>'+b.replace(/<source[^>]*>/g,'')+'</div>';
  return '<!DOCTYPE html>\n<html lang="en-GB">\n<head>\n<meta charset="utf-8">\n<!-- GENERATED by prism-build/build-user-guide.js. Never edit by hand. -->\n'+
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>'+BOOK+
    '</title>\n<style>body{font:13px/1.5 sans-serif;max-width:860px;margin:auto;padding:24px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:4px}'+
    CSS+'</style>\n</head>\n<body class="help-book">\n'+b+'</body>\n</html>\n';
}
var B='.help-book ',CSS=B+'h2{border-bottom:2px solid #f0883e}.bk-ch,.bk-card,.bk-ws{break-before:page}.bk-n,.bk-k{color:#bc4c00;font-weight:700}'+
  B+'figure img{width:60%;height:auto;border:.5px solid #999}'+B+'figcaption,'+B+'.help-note{color:#666;font-size:12px}'+B+'.help-shot-missing{border:1px dashed #999;padding:8px}'+
  B+'.help-enlarge{display:none}'+B+'.help-co{display:inline-block;width:16px;border-radius:50%;background:#f0b429;font:700 10px/16px sans-serif;text-align:center}'+
  '.help-v-ok{color:#1a7f37}.help-v-warn{color:#9a6700}.help-v-bad{color:#cf222e}.bk-x,.bk-toc a{color:inherit;text-decoration:none}.bk-toc ol{list-style:none}'+
  '.bk-line{border-bottom:1px solid #999;height:24px}@page{size:A4;margin:14mm}@media print{body{padding:0}'+B+'figure,'+B+'tr{break-inside:avoid}'+B+'h3,'+B+'h4{break-after:avoid}}';

var uri=u=>G.fetch(u).then(r=>r&&r.ok?r.blob():null).then(b=>!b||!G.FileReader?null:new Promise(res=>{
  var f=new G.FileReader();f.onload=()=>res(f.result);f.onerror=()=>res(null);f.readAsDataURL(b);
})).then(null,()=>null);
function title(s){
  var m=SC.exec(s),e=m&&C().course.filter(x=>x.id===m[2])[0];
  return s==='all'?BOOK:!m?H.titleOf(s):m[1]==='card'?'Quick card — '+H.titleOf(m[2]):'Worksheet — '+pt(e?e.title:m[2]);
}
function send(t,h,sub){
  if(typeof exportReport==='function')return exportReport(t,h,sub); // host scope (→ __reportOverride on iOS)
  var f=G.PRiSM_hostExportReport||G.__reportOverride;
  return typeof f==='function'?f(t,h,sub):null;
}
// → Promise {title, html, images, missing}; an unreadable file leaves the map (other view, else caption)
function print(scope,op){
  var F=files(),d={},miss=[],R=rel(),t=title(scope),o={files:F,dataUris:d,images:!op||op.images!==false,imgBase:IMG};
  var next=()=>{
    var w=[];
    renderBook(scope,o).replace(/<img class="help-img"[^>]*? src="help\/img\/([^"?]+)\?/g,(m,f)=>{if(w.indexOf(f)<0)w.push(f);});
    return!w.length?Promise.resolve():w.reduce((p,f)=>p.then(()=>(G.fetch?uri(IMG+f+'?v='+(F[f].h8||'')):null)).then(u=>{if(u)d[f]=u;else{miss.push(f);delete F[f];}}),Promise.resolve()).then(next);
  };
  return next().then(()=>{
    var h=renderBook(scope,o);
    G.__reportKicker='User guide';   // host H6: the report cover says "User guide", not "Engineering calculation report"
    try{send(t,h,'User guide · Well Testing Suite '+(R.ver||'')+when(R));}finally{try{delete G.__reportKicker;}catch(e){G.__reportKicker=undefined;}}
    return{title:t,html:h,images:Object.keys(d).length,missing:miss};
  });
}
// iOS: bundled guide in a same-origin reader (img/ resolves offline)
function openReader(){
  var root=byId('help_root'),d=byId('help_rd'),x;
  if(!root)return null;
  if(!d){
    x=document.createElement('div');
    x.innerHTML='<dialog id="help_rd" class="help-rd" aria-label="User Guide"><form method="dialog" class="help-rd-bar"><span>For a PDF, open <a href="https://'+SITE+'/'+UG+'" target="_blank">'+SITE+'/'+UG+'</a> and print it.</span><button id="help_rd_x" aria-label="Close">✕</button></form><iframe id="help_rd_f" title="User Guide" src="'+UG+'?v='+(rel().ver||'')+'"></iframe></dialog>';
    root.appendChild(d=x.firstChild);
    d.addEventListener('close',()=>{var p=byId('help_pm');if(p)p.focus();});
  }
  try{d.showModal();}catch(e){d.setAttribute('open','');}
  return d;
}
function items(v){
  v=v||{};
  var c=C(),out=[],r=v.kind==='guide'&&c.guides[v.route]&&v.route,g=r&&H.sidebarGroups().filter(x=>x.routes.indexOf(r)>-1)[0];
  if(r)out.push(['Quick card','card:'+v.route],['This guide',v.route]);
  if(g&&g.label!=='Other')out.push(['This group: '+g.label,g.label]);
  if(v.kind==='course'||v.kind==='wpcourse')EX(v.kind).forEach((x,i)=>out.push(['Worksheet: '+(i+1)+' '+pt(x.title),'worksheet:'+x.id]));
  return out.concat([['Whole user guide','all']]);
}
function fill(v){var l=byId('help_pm');if(l)l.innerHTML='<option value="">Print ▾</option>'+items(v).map(x=>'<option value="'+esc(x[1])+'">'+esc(x[0])+'</option>').join('');}
function run(scope){
  var off=byId('help_pm_noimg'),say=t=>{var m=byId('help_pm_msg');if(m)m.textContent=t;};
  if(scope==='all'&&document.documentElement.classList.contains('ios-app'))return Promise.resolve(openReader());
  say('Preparing…');
  return print(scope,{images:!(off&&off.checked)})
    .then(r=>{say('Sent to print.'+(r.missing.length?' '+r.missing.length+' screenshot(s) as captions.':''));return r;},e=>say('Printing failed: '+((e&&e.message)||'unknown error')));
}
var RCSS='.help-rd[open]{display:flex;flex-direction:column;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:var(--bg0);color:var(--text)}'+
  '.help-rd-bar{display:flex;gap:10px;align-items:center;padding:6px 10px}.help-rd-bar span{flex:1}#help_rd_x{min-width:44px;min-height:44px}#help_rd_f{flex:1;border:0;background:#fff}';
// iOS safe-area padding for the reader lives in ios-app/ios-additions/ios-styles.css (section 8), never in the web code.
// Print ▾ as a native select (resets after each choice)
H.printMenu=slot=>{
  if(!slot)return;
  slot.innerHTML=' · <select id="help_pm" aria-label="Print" data-no-persist></select> <label><input type="checkbox" id="help_pm_noimg" data-no-persist> Images off</label>'+
    ' <span id="help_pm_msg" class="help-note" role="status"></span><style>'+RCSS+'</style>';
  slot.addEventListener('change',e=>{var t=e.target;if(t.id==='help_pm'&&t.value){var v=t.value;t.value='';run(v);}});
  fill(H.view&&H.view());
};
Object.assign(H,{onShow:fill,renderBook,print,printRun:run,printItems:items,bookPlan:plan,openReader});
})();

// === SELF-TEST ===
(function(){
  var H=((typeof window!=='undefined')?window:globalThis).WTS_help;
  if(!H||typeof H.renderBook!=='function'||typeof H.printMenu!=='function')throw new Error('[49-calc-help-print] self-test: API missing');
})();
