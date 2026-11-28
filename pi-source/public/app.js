'use strict';
// BMW AI Weboberfläche.
// Abschnitte: Grundlagen · Anmeldung · Reiter · Chat · Freigaben · Diagnose (Diagnosemodus für
// Claude, MGU, Berichte) · Konsole · Fahrzeug · Dateien · Chat-Import/-Export · System · Auto-Reload.

// ----- Grundlagen -----
let token=sessionStorage.getItem('bmw-ai-token')||'',conversationId='',currentTab='chat';
function authHeaders(){return token==='cookie'?{'x-bmw-ai-client':'1'}:{authorization:'Bearer '+token,'x-bmw-ai-client':'1'};}
const $=s=>document.getElementById(s);
const txt=(tag,value,cls)=>{const e=document.createElement(tag);if(cls)e.className=cls;e.textContent=String(value);return e;};
let noticeTimer=null;
function notice(s){
 const n=$('notice');n.textContent=s;n.classList.toggle('is-visible',!!s);
 clearTimeout(noticeTimer);if(s)noticeTimer=setTimeout(()=>n.classList.remove('is-visible'),7000);
}
async function api(endpoint,method='GET',data,raw){
 const headers=authHeaders();if(data&&!raw)headers['content-type']='application/json';
 const res=await fetch('/api/v1'+endpoint,{method,headers,body:raw?data:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(endpoint==='/faults/read'?110000:endpoint==='/faults/reference'?180000:60000)});
 const result=await res.json().catch(()=>({error:'Invalid response'}));
 if(!res.ok)throw Error(result.error||'HTTP '+res.status);
 return result;
}
const clock=iso=>new Date(iso).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
const stamp=iso=>iso?new Date(iso).toLocaleString('de-DE',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'';
function triggerFileDownload(blob,filename){
 const u=URL.createObjectURL(blob),a=document.createElement('a');
 a.href=u;a.download=filename;document.body.appendChild(a);a.click();a.remove();
 setTimeout(()=>URL.revokeObjectURL(u),30000);
}
async function authenticatedDownload(path,name){
 try{const r=await fetch('/api/v1'+path,{headers:authHeaders()});if(!r.ok)throw Error('HTTP '+r.status);triggerFileDownload(await r.blob(),name);}
 catch(e){notice(e.message);}
}

// ----- MGU-Kopplung per QR-Link (/pair?ip=…&code=…) -----
const pairParams=new URLSearchParams(location.search);
const pendingPair=(location.pathname==='/pair'&&/^[0-9a-f]{32}$/.test(pairParams.get('code')||'')&&/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(?:\d{1,3}\.)\d{1,3}$/.test(pairParams.get('ip')||''))?{ip:pairParams.get('ip'),code:pairParams.get('code')}:null;
if(location.pathname==='/pair')history.replaceState(null,'','/');
function renderPair(){const panel=$('pairPanel');panel.hidden=!pendingPair;if(pendingPair){$('pairDescription').textContent='Neue BMW-MGU mit Tailscale-Adresse '+pendingPair.ip+' koppeln? Die Kopplung erfolgt nur nach deiner ausdrücklichen Bestätigung.';}}
$('pairButton').onclick=async()=>{if(!pendingPair||!token)return;const btn=$('pairButton');btn.disabled=true;try{const d=await api('/pair','POST',pendingPair);$('pairDescription').textContent='Erfolgreich gekoppelt: '+d.host;$('pairError').textContent='';btn.hidden=true;await refreshStatus();}catch(e){$('pairError').textContent=e.message;btn.disabled=false;}};

// ----- Anmeldung -----
let pollTimer=null;
function show(){
 $('login').hidden=!!token;$('shell').hidden=!token;$('logout').hidden=!token;
 if(!token){clearInterval(pollTimer);pollTimer=null;$('diagPill').hidden=true;return;}
 const resumeConvo=sessionStorage.getItem('bmw-ai-resume-conversation');
 const resumeTab=sessionStorage.getItem('bmw-ai-resume-tab')||(/^#[a-z-]+$/.test(location.hash)?location.hash.slice(1):'');
 if(resumeConvo)conversationId=resumeConvo;
 refreshConvos();refreshJobs();refreshPlanStatus();refreshDiagMode();refreshFiles();
 // Hält Freigabe-Zähler und Diagnosemodus aktuell, auch wenn Claude im Hintergrund etwas vorschlägt.
 if(!pollTimer)pollTimer=setInterval(()=>{if(!document.hidden)refreshDiagMode();},5000);
 if(resumeTab){
  openTab(resumeTab);
  sessionStorage.removeItem('bmw-ai-resume-tab');
  sessionStorage.removeItem('bmw-ai-resume-conversation');
 }
 if(pendingPair){openTab('diag');renderPair();}
}
async function postLogin(remember){
 const r=await fetch('/api/v1/login',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-bmw-ai-client':'1'},body:JSON.stringify({password:$('password').value,remember,plainHttp:location.protocol==='http:'})});
 const d=await r.json();if(!r.ok)throw Error(d.error);return d;
}
$('loginButton').onclick=async()=>{
 const button=$('loginButton');button.disabled=true;
 try{
  let d=await postLogin($('rememberMe').checked),hint='';
  if(d.remembered){
   // Das dauerhafte Login ist ein Cookie (über http://<Tailnet-IP> eine eigene Variante ohne
   // Secure). Prüfen, ob der Browser es angenommen hat; sonst normal für diesen Tab anmelden.
   const kept=await fetch('/api/v1/session',{credentials:'same-origin',headers:{'x-bmw-ai-client':'1'}}).then(r=>r.ok).catch(()=>false);
   if(!kept){d=await postLogin(false);hint='Dein Browser hat das dauerhafte Login nicht angenommen. Du bist für diesen Tab angemeldet.';}
  }
  token=d.remembered?'cookie':d.token;
  if(d.remembered)sessionStorage.removeItem('bmw-ai-token');else sessionStorage.setItem('bmw-ai-token',token);
  $('password').value='';$('loginError').textContent='';show();if(hint)notice(hint);
 }catch(e){$('loginError').textContent=e.message;}
 finally{button.disabled=false;}
};
$('password').onkeydown=e=>{if(e.key==='Enter')$('loginButton').click();};
$('logout').onclick=async()=>{try{await api('/logout','POST');}catch(e){}token='';sessionStorage.removeItem('bmw-ai-token');show();};
async function restoreSession(){
 if(token){try{await api('/session');show();return;}catch(e){token='';sessionStorage.removeItem('bmw-ai-token');}}
 try{const r=await fetch('/api/v1/session',{credentials:'same-origin',headers:{'x-bmw-ai-client':'1'}});if(r.ok){token='cookie';show();return;}}catch(e){}
 show();
}

// ----- Fahrzeug: Reifen und Dieselpartikelfilter -----
const barText=v=>v===null||v===undefined?'–':v.toFixed(2).replace('.',',')+' bar';
const num1=v=>v===null||v===undefined?'–':(Math.round(v*10)/10).toLocaleString('de-DE');
function renderTyres(t){
 const box=$('tyreList');box.replaceChildren();
 $('tyreAge').textContent=t?[t.stale?'Veraltet':null,t.source||'TPMSInternalData',stamp(t.at)].filter(Boolean).join(' · '):'keine Daten';
 $('tyreAge').className='pill '+(t&&!t.stale?'pill-live':'pill-off');
 if(!t){box.appendChild(txt('p','Keine Reifendaten empfangen.','hint'));return;}
 const entries=new Map(t.wheels.map(w=>[w.position,w]));
 const wheelLabels={FRONT_LEFT:'vorne links',FRONT_RIGHT:'vorne rechts',REAR_LEFT:'hinten links',REAR_RIGHT:'hinten rechts'};
 const wheels=Object.entries(wheelLabels).map(([position,name])=>entries.get(position)||{name,p:null,target:null,temp:null,change7d:null});
 if(entries.has('SPARE_TYRE'))wheels.push(entries.get('SPARE_TYRE'));
 for(const w of wheels){
  const card=txt('div','','tyre'+(w.low?' tyre-low':''));
  card.appendChild(txt('span',w.name,'hint'));
  card.appendChild(txt('strong',barText(w.p)));
  if(w.low)card.appendChild(txt('span','Druckhinweis','hint error'));
  card.appendChild(txt('span',[w.target?'Soll '+barText(w.target):'',w.temp!==null?w.temp+' °C':''].filter(Boolean).join(' · ')||'–','hint'));
  if(Number.isFinite(w.p)&&Number.isFinite(w.target))card.appendChild(txt('span','Abweichung '+(w.p>w.target?'+':'')+barText(w.p-w.target),'hint'));
  if(w.change7d!==null)card.appendChild(txt('span',(w.change7d>0?'+':'')+w.change7d.toFixed(2).replace('.',',')+' bar in 7 Tagen',Math.abs(w.change7d)>=0.15?'error':'hint'));
  box.appendChild(card);
 }
}
function renderDpf(d){
 const vals=$('dpfValues'),regs=$('dpfRegens');vals.replaceChildren();regs.replaceChildren();
 $('dpfAge').textContent=d?(d.stale?'Veraltet · ':'Gelesen · ')+stamp(d.latest.at):'keine Daten';
 $('dpfAge').className='pill '+(d&&!d.stale?'pill-live':'pill-off');
 if(!d){vals.appendChild(txt('p','Noch keine Werte.','hint'));return;}
 const l=d.latest;
 for(const [label,key,unit] of [['Ruß','soot',' g'],['Asche','ash',' g'],['Seit Regeneration','distance',' km'],['Regenerationen','regenCount',''],['Ø Abstand','regenAverage',' km'],['Temperatur','temperature',' °C']]){
  const value=l[key];
  if(value===null||value===undefined)continue;
  const c=txt('div','','stat');c.appendChild(txt('span',label,'hint'));c.appendChild(txt('strong',num1(value)+unit));vals.appendChild(c);
 }
 if(!d.regens.length)regs.appendChild(txt('p','Noch keine Regeneration erkannt.','hint'));
 for(const r of d.regens){
  const row=txt('div','','list-row');row.appendChild(txt('strong',stamp(r.at)));
  row.appendChild(txt('span',[r.km!==null?kmText(r.km):'',r.distanceBefore!==null?'nach '+num1(r.distanceBefore)+' km':'',r.sootBefore!==null?'Ruß vorher '+num1(r.sootBefore)+' g':''].filter(Boolean).join(' · '),'hint'));
  regs.appendChild(row);
 }
}

// ----- Fehler: Check-Control und Fehlerspeicher -----
const DTC_LABELS={ACTIVE:'aktuell vorhanden','WARNING LAMP':'Warnanzeige angefordert',PENDING:'vorläufig',STORED:'bestätigt',HISTORY:'Historie'};
let displayedFaults=null;
for(const id of ['faultEcu','faultState','faultQuery'])$(id).oninput=()=>{if(displayedFaults)renderFaults(displayedFaults);};
function setFaultBadge(f){
 const active=f.checkControl.active.filter(row=>!row.stale).length;
 const received=(f.checkControl.received||[]).length;
 const dtcs=f.faultMemory.latest?f.faultMemory.latest.dtcs.filter(d=>d.active).length:0;
 const n=active+dtcs;
 $('faultBadge').title=active+' bestätigte aktuelle Check-Control-Meldungen · '+received+' Meldungen mit unbekanntem Aktivstatus · '+dtcs+' aktive DTCs im letzten Scan';
 $('faultBadge').textContent=String(n);$('faultBadge').hidden=!n;
}
function dtcRow(d,extra){
 const row=txt('div','','list-row'),info=txt('div','','request-info');
 const head=txt('span','');head.appendChild(txt('strong',d.code));
 head.appendChild(txt('span',DTC_LABELS[d.label]||d.label||'','pill '+(d.active?'due-pill-overdue':'pill-off')));
 if(d.isNew)head.appendChild(txt('span','neu','pill due-pill-soon'));
 info.appendChild(head);
 info.appendChild(txt('strong',d.title||'Fehlerbeschreibung nicht verfügbar'));
 const reason={database_missing:'Lokale Fehlertextdatenbank fehlt',database_invalid:'Lokale Fehlertextdatenbank konnte nicht geladen werden',
  identity_missing:'Geprüfte ECU-/SGBD-Identität fehlt',ambiguous:'Fehlertextzuordnung nicht eindeutig',unknown_code:'Code für diese ECU-Identität nicht im Katalog'};
 if(Object.prototype.hasOwnProperty.call(reason,d.textReason))info.appendChild(txt('span',reason[d.textReason],'hint'));
 const quality={exact_variant:'Steuergerätespezifisch zugeordnet',family_consensus:'Übereinstimmung in der ECU-Familie',
  address_consensus:'Übereinstimmung an der Diagnoseadresse',global_consensus:'Allgemeiner Referenztext – ECU-Zuordnung nicht bestätigt',
  unknown_code:'Kein Referenztext verfügbar'};
 if(quality[d.referenceQuality])info.appendChild(txt('span',quality[d.referenceQuality]+(d.referenceLanguage==='en'?' · Englisch':''),'hint'));
 if(d.referenceCandidates?.length){
  const candidates=txt('details','');
  candidates.appendChild(txt('summary','Referenzkandidaten ('+d.candidateCount+')'));
  for(const candidate of d.referenceCandidates)candidates.appendChild(txt('p',[candidate.variant,candidate.title,candidate.source].join(' · '),'hint'));
  info.appendChild(candidates);
 }
 if(d.description)info.appendChild(txt('p',d.description,'notes'));
 info.appendChild(txt('span',extra,'hint'));
 const detail=txt('details','','');
 detail.append(txt('summary','Technische Details'),txt('p',[d.statusHex,(d.bits||[]).join(', '),d.sgbd,d.textSource].filter(Boolean).join(' · ')||'Keine Zusatzdaten','hint'));
 info.appendChild(detail);row.appendChild(info);return row;
}
function renderCheckControl(act,cc,poll){
 act.replaceChildren();
 const received=cc.received||[];
 if(cc.status!=='read')act.appendChild(txt('p',cc.status==='stale'?
  'Zuletzt bekannter Fahrzeugstand.':'Eine vollständige aktuelle Meldungsliste liegt noch nicht vor.','hint'));
 else act.appendChild(txt('p',cc.active.length?'Vollständige Liste empfangen · '+stamp(cc.listAt):'Beim Listenabruf '+stamp(cc.listAt)+' waren keine Meldungen aktiv.','hint'));
 const ccStyle={RED:['critical','⚠','Kritisch'],YELLOW:['warning','⚠','Warnung'],ORANGE:['warning','⚠','Warnung'],
  GREEN:['ok','ⓘ',null],WHITE:['neutral','ⓘ',null],DEFAULT:['neutral','ⓘ',null]};
 for(const c of [...cc.active,...received]){
  const [style,icon,severity]=ccStyle[c.color]||ccStyle.DEFAULT;
  const card=txt('div','','service-entry cc-message cc-'+style);
  card.appendChild(txt('strong',icon+' '+(c.text||'Meldung '+c.id)));
  const status=c.active===null?'Aktivstatus nicht bestätigt':c.stale?'Zuletzt als aktiv bestätigt':'Bestätigt aktiv';
  const time=c.active===null?'Empfangen '+stamp(c.at):'Seit '+stamp(c.since)+' · zuletzt '+stamp(c.lastSeen);
  card.appendChild(txt('p',[status,c.stale&&c.active===null?'zuletzt bekannt':null,severity,time].filter(Boolean).join(' · '),'hint'));
  const details=document.createElement('details');
  details.appendChild(txt('summary',c.description?'Beschreibung und technische Details':'Technische Details'));
  if(c.description)details.appendChild(txt('p',c.description,'notes'));
  details.appendChild(txt('p',['ID '+c.id,c.ecu!=null?c.ecuName+' (0x'+c.ecu.toString(16).toUpperCase().padStart(2,'0')+')':null,
   c.color,c.symbolId!=null?'Symbol '+c.symbolId:null,c.riskClass,c.type,c.source,c.textSource,c.descriptionSource,c.occurrences?
   c.occurrences+'× erfasst seit '+stamp(c.firstSeen):null].filter(Boolean).join(' · '),'hint'));
  card.appendChild(details);
  act.appendChild(card);
 }
 if(cc.status!=='read'){
  const tech=txt('details','');
  tech.appendChild(txt('summary','Technischer Abfragestatus'));
  const causes={failed:'Listenabruf fehlgeschlagen.',unavailable:'Provider bzw. Listenquelle nicht verfügbar.',
   stale:'Letzte vollständige Liste ist veraltet.',unknown:'Vollständige Liste noch nicht empfangen.'};
  tech.appendChild(txt('p',[causes[cc.status],missingSignal(poll,['CheckControlMaster.basicList','KombiInterface_2.ccList','KombiInterface_2.ccListRiskClass'])]
   .filter(Boolean).join(' · '),'hint'));
  act.appendChild(tech);
 }
}
function renderFaults(f){
 displayedFaults=f;
 setFaultBadge(f);
 const diagnosis=f.diagnosis||{},poll=diagnosis.poll||{},ecu=poll.signals&&poll.signals.Diagnostics;
 $('faultConnection').textContent=[poll.ok?'MGU erreichbar':'MGU-Status: '+(poll.error||'unbekannt'),vehicleState(poll),ecu?(ecu.available?'Diagnosedienst erreichbar':ecu.error||'Diagnosedienst nicht verfügbar'):'Keine Rückmeldung vom Diagnosedienst',diagnosis.running?'Abfrage läuft':''].filter(Boolean).join(' · ');
 const cc=f.checkControl,received=cc.received||[];
 renderCheckControl($('ccActive'),cc,poll);
 const ev=$('ccEvents');ev.replaceChildren();
 if(!f.checkControl.events.length)ev.appendChild(txt('p','Noch kein Verlauf.','hint'));
 for(const e of f.checkControl.events){
  const row=txt('div','','list-row');row.appendChild(txt('span',stamp(e.at),'hint'));
  row.appendChild(txt('strong',(e.text||'Meldung '+e.id)));row.appendChild(txt('span',e.active===null?'empfangen · Aktivstatus unbekannt':e.active?'bestätigt aktiv':'bestätigt erloschen','pill '+(e.active?'due-pill-soon':'pill-off')));
  ev.appendChild(row);
 }
 const fm=f.faultMemory,list=$('faultList');list.replaceChildren();
 const archive=$('faultArchive');
 archive.replaceChildren(new Option('Aktuelle Kopplung',''),...(f.archives||[]).map((a,i)=>new Option('Archiv '+(i+1)+' · '+stamp(a.lastAt),a.key)));
 archive.value=f.archiveKey||'';
 const texts=f.texts;
 if(texts?.reference?.state)showReference(texts.reference);
 const sqlite=texts?.reference;
 const referenceSummary=sqlite?.state==='ready'?(sqlite.meta?.counts?.codes??0)+' DTCs in SQLite':
  sqlite?.state==='missing'?'SQLite-Referenz fehlt':sqlite?.state?'SQLite-Referenz nicht verfügbar':'SQLite-Referenz ungeprüft';
 $('faultTextCatalog').textContent=texts?[referenceSummary,
  texts.count||texts.ecuCount?texts.count+' lokale JSON-Fehlertexte · '+texts.ecuCount+' ECU-Zuordnungen':null]
   .filter(Boolean).join(' · '):'Fehlertextkatalog ungeprüft';
 if(sqlite?.meta&&Object.keys(texts.resolution||{}).length)$('faultTextCatalog').textContent+=
  ' · Zuordnung: '+Object.entries(texts.resolution).map(([k,v])=>k+' '+v).join(', ');
 const latest=fm.latest,last=fm.lastAttempt,filter=$('faultEcu'),selected=filter.value;
 const available=new Map([...(latest?.dtcs||[]),...fm.earlier].map(d=>[String(d.ecu),d.ecuName]));
 filter.replaceChildren(new Option('Alle',''),...Array.from(available,([id,name])=>new Option(name,id)));
 if(available.has(selected))filter.value=selected;
 const query=$('faultQuery').value.trim().toLowerCase(),status=$('faultState').value;
 const matches=d=>(!filter.value||filter.value===String(d.ecu))&&(!status||(d.bits||[]).includes(status))&&
  (!query||[d.code,d.title,d.description,d.ecuName,d.referenceVariant,...(d.referenceCandidates||[]).flatMap(c=>[c.title,c.variant])].some(x=>String(x||'').toLowerCase().includes(query)));
 $('faultCounts').textContent=f.checkControl.active.length+' Check-Control zuletzt bestätigt aktiv · '+received.length+' mit unbekanntem Aktivstatus · '+(latest?latest.dtcs.length+' DTC insgesamt · '+latest.dtcs.filter(d=>d.active).length+' aktuell vorhanden im letzten Scan':'Noch kein DTC-Scan');
 $('faultInfo').textContent=!latest?(last&&last.error?'Letzter Versuch '+stamp(last.readAt)+' fehlgeschlagen: '+last.error:'Noch nicht ausgelesen. Das passiert bei jedem Fahrzeugstart einmal automatisch.')
  :'Ausgelesen '+stamp(latest.readAt)+': '+latest.dtcs.length+' Codes aus '+latest.ecus.length+' Steuergeräten'+(last&&last.error&&last.readAt!==latest.readAt?' · letzter Versuch fehlgeschlagen: '+last.error:'');
 if(latest){
  const byEcu=new Map();for(const d of latest.dtcs.filter(matches)){if(!byEcu.has(d.ecu))byEcu.set(d.ecu,[]);byEcu.get(d.ecu).push(d);}
  if(!byEcu.size)list.appendChild(txt('p',latest.dtcs.length?'Keine passenden Fehlercodes.':'Keine passenden Fehlercodes im abgefragten Statusfilter des Fahrzeugs.','hint'));
  for(const [ecu,codes] of byEcu){
   const box=txt('div','','service-entry');box.appendChild(txt('strong',codes[0].ecuName+' (0x'+ecu.toString(16).toUpperCase().padStart(2,'0')+')'));
   for(const d of codes)box.appendChild(dtcRow(d,[d.statusHex,d.firstSeen?'erstmals '+stamp(d.firstSeen):'',d.lastSeen?'zuletzt '+stamp(d.lastSeen):''].filter(Boolean).join(' · ')));
   list.appendChild(box);
  }
  const refused=latest.ecus.filter(e=>!e.ok);
  if(refused.length)list.appendChild(txt('p','Ohne Antwort oder abgelehnt: '+refused.map(e=>e.ecuName+(e.nrc?' ('+e.nrc+')':'')).join(', '),'hint'));
 }
 const earlier=$('faultEarlier');earlier.replaceChildren();
 if(!fm.earlier.length)earlier.appendChild(txt('p','Keine.','hint'));
 for(const k of fm.earlier.filter(matches))earlier.appendChild(dtcRow(k,k.ecuName+' · zuletzt '+stamp(k.lastSeen)+
  (k.noLongerReportedAt?' · seit '+stamp(k.noLongerReportedAt)+' im Scan nicht mehr gemeldet':' · im letzten Scan nicht beobachtet')));
}
$('faultCatalogForm').onsubmit=async event=>{
 event.preventDefault();
 const result=$('faultImportResult'),button=event.currentTarget.querySelector('button');
 button.disabled=true;
 result.textContent='Import wird geprüft …';
 try{
  const catalog=$('faultCatalogFile').files[0],ids=$('faultIdentityFile').files[0];
  if(!catalog||!ids||catalog.size+ids.size>20*1024*1024)throw Error('Zwei JSON-Dateien und insgesamt höchstens 20 MiB erforderlich.');
  const imported=await api('/faults/import-catalog','POST',{catalog:JSON.parse(await catalog.text()),identities:JSON.parse(await ids.text())});
  result.textContent=imported.count+' Fehlertexte für '+imported.ecuCount+' Steuergeräte installiert.';
  $('faultCatalogForm').reset();
  await refreshFaults();
 }catch(e){result.textContent=e.message;}
 finally{button.disabled=false;}
};
let referenceState=null;
function showReference(value){
 referenceState=value;
 const meta=value?.meta,c=meta?.counts;
 $('referenceStatus').textContent=meta?
  ['Version '+meta.version,stamp(meta.importedAt),meta.source,c.codes+' Codes',c.variants+' Varianten',
   (c.de||0)+' deutsche und '+(c.en||0)+' englische Texte',(c.descriptions||0)+' Beschreibungen',
   (meta.bytes/1048576).toFixed(1)+' MiB'].join(' · '):
  value?.state==='invalid_or_unavailable'?'SQLite ungültig oder Python 3 nicht verfügbar.':'SQLite-Referenz bislang nicht installiert.';
}
$('referenceCheck').onclick=async()=>{
 try{showReference(await api('/faults/reference'));}catch(e){$('referenceStatus').textContent=e.message;}
};
$('referenceForm').onsubmit=async event=>{
 event.preventDefault();
 const file=$('referenceFile').files[0],button=event.currentTarget.querySelector('button');
 if(!file||file.size>192*1024*1024)return notice('SQLite-Datei bis 192 MiB auswählen.');
 button.disabled=true;$('referenceStatus').textContent='Referenz wird übertragen und geprüft …';
 try{
  const meta=await api('/faults/reference','POST',file,true);
  showReference({state:'ready',meta});
 }catch(e){$('referenceStatus').textContent=e.message;}
 finally{button.disabled=false;}
};
$('referenceRestore').onclick=async()=>{
 if(!confirm('Die letzte gesicherte Fehlertextdatenbank wiederherstellen?'))return;
 try{showReference({state:'ready',meta:await api('/faults/reference/restore','POST')});}
 catch(e){$('referenceStatus').textContent=e.message;}
};
$('referenceReport').onclick=()=>{
 if(referenceState?.meta)triggerFileDownload(new Blob([JSON.stringify(referenceState.meta,null,2)],{type:'application/json'}),'bmw-dtc-importbericht.json');
};
async function refreshFaults(){if(!token)return;try{renderFaults(await api('/faults'+($('faultArchive').value?'?archive='+encodeURIComponent($('faultArchive').value):'')));}catch(e){notice(e.message);}}
$('refreshFaults').onclick=refreshFaults;
$('faultArchive').onchange=refreshFaults;
$('vehicleCheckControlDetails').onclick=()=>openTab('faults');
$('faultRead').onclick=async()=>{
 const b=$('faultRead');$('faultArchive').value='';b.disabled=true;b.textContent='Liest … (bis 90 s)';
 try{renderFaults(await api('/faults/read','POST'));notice('Fehlerspeicher ausgelesen.');}
 catch(e){notice(e.message);refreshFaults();}
 finally{b.disabled=false;b.textContent='Jetzt auslesen';}
};

// ----- System: Benachrichtigungen -----
function renderNotify(n){
 $('notifyEnabled').checked=n.enabled;$('notifyServer').value=n.server;$('notifyTopic').value=n.topic;
 $('notifyToken').placeholder=n.hasToken?'gespeichert (leer lassen = behalten)':'leer lassen für ntfy.sh';
 const cats=$('notifyCategories');cats.replaceChildren();
 for(const [k,label] of Object.entries(n.labels)){const l=document.createElement('label');l.className='check';const c=document.createElement('input');c.type='checkbox';c.dataset.cat=k;c.checked=n.categories[k]!==false;l.append(c,document.createTextNode(' '+label));cats.appendChild(l);}
 const log=$('notifyLog');log.replaceChildren();
 if(!n.log.length)log.appendChild(txt('p','Noch nichts gesendet.','hint'));
 for(const e of n.log){const row=txt('div','','list-row');row.appendChild(txt('span',stamp(e.at),'hint'));row.appendChild(txt('strong',e.title));row.appendChild(txt('span',e.ok?'zugestellt':'Fehler: '+(e.error||'?'),e.ok?'hint':'error'));log.appendChild(row);}
 const p=n.poll||{};
 $('pollInfo').textContent=p.ok?'Hintergrundabfrage zuletzt erfolgreich '+stamp(p.lastOk):
  mguConnectionText(p)+(p.lastOk?' Zuletzt erreichbar '+stamp(p.lastOk)+'.':'');
}
async function refreshNotify(){try{renderNotify(await api('/notify'));}catch(e){notice(e.message);}}
$('notifySave').onclick=async()=>{
 const d={enabled:$('notifyEnabled').checked,server:$('notifyServer').value,topic:$('notifyTopic').value,categories:{}};
 if($('notifyToken').value)d.token=$('notifyToken').value;
 $('notifyCategories').querySelectorAll('input').forEach(c=>d.categories[c.dataset.cat]=c.checked);
 try{renderNotify(await api('/notify','POST',d));$('notifyToken').value='';notice('Gespeichert.');}catch(e){notice(e.message);}
};
$('notifyTest').onclick=async()=>{const b=$('notifyTest');b.disabled=true;try{renderNotify(await api('/notify/test','POST'));notice('Test gesendet. Kommt er auf dem Handy an?');}catch(e){notice(e.message);refreshNotify();}finally{b.disabled=false;}};

// ----- Reiter -----
// Frühere Reiternamen (Lesezeichen, QR-Links, gespeicherte Ansicht) führen zum neuen Ort.
const TAB_ALIASES={status:'diag',reports:'diag',actions:'diag',logs:'system',updates:'system',service:'vehicle'};
function openTab(name){
 name=TAB_ALIASES[name]||name;
 const button=document.querySelector('#tabs [data-tab="'+name+'"]');if(!button)return;
 currentTab=name;
 if(name==='console')history.replaceState(null,'',location.pathname+location.search+'#console');
 document.querySelectorAll('section.tab').forEach(s=>s.hidden=s.id!==name);
 $('tabs').querySelectorAll('button[data-tab]').forEach(t=>t.classList.toggle('active',t===button));
 $('tabsMoreToggle').classList.toggle('active',!!button.closest('#tabsExtra'));
 setMoreTabs(false);
 ({jobs:refreshJobs,vehicle:refreshVehicle,stats:refreshStats,faults:refreshFaults,diag:refreshDiag,files:refreshFilesTab,system:refreshSystem,console:refreshConsoleConnection}[name]||(()=>{}))();
}
$('tabs').querySelectorAll('button[data-tab]').forEach(b=>b.onclick=()=>openTab(b.dataset.tab));
// iPhone: seltene Reiter liegen unter „Mehr“.
function setMoreTabs(open){$('tabs').classList.toggle('more-open',open);$('tabsMoreToggle').setAttribute('aria-expanded',String(open));}
$('tabsMoreToggle').onclick=e=>{e.stopPropagation();setMoreTabs(!$('tabs').classList.contains('more-open'));};
document.addEventListener('click',e=>{if(!e.target.closest('#tabs'))setMoreTabs(false);});

// ----- Chat -----
async function refreshConvos(){try{const data=await api('/conversations'),sel=$('convos');sel.replaceChildren();sel.appendChild(new Option('Neuer Chat',''));data.conversations.forEach(c=>sel.appendChild(new Option((c.importSource==='ChatGPT'?'[ChatGPT-Import] ':'')+c.title,c.id)));sel.value=conversationId;if(conversationId)await loadMessages();}catch(e){notice(e.message);}}
function addMessage(m){const node=txt('div',m.content,'message '+m.role);node.prepend(txt('span',m.role==='user'?'Du':'Assistent','meta'));$('messages').appendChild(node);$('messages').scrollTop=$('messages').scrollHeight;}
async function loadMessages(){$('messages').replaceChildren();if(!conversationId)return;const d=await api('/conversations/'+conversationId+'/messages');d.messages.forEach(addMessage);}
async function refreshPlanStatus(){try{const c=await api('/config');const p=c.chatgptPlan||{};$('chatgptPlanStatus').textContent=p.permission?'ChatGPT-Plus-Anmeldung aktiv'+(p.email?' ('+p.email+')':'')+' – Nutzung über das Abo, kein zusätzlicher API-Schlüssel.':p.connected?'ChatGPT-Konto angemeldet, Planfreigabe fehlt. OAuth-Anmeldung erneut durchführen.': 'ChatGPT-Plan nicht verbunden. OAuth-Anmeldung auf dem Raspberry Pi über Termius starten.';}catch(e){$('chatgptPlanStatus').textContent='Planstatus unbekannt: '+e.message;}}
$('newChat').onclick=()=>{conversationId='';$('convos').value='';$('messages').replaceChildren();notice('Neuer Chat');};
$('convos').onchange=()=>{conversationId=$('convos').value;loadMessages().catch(e=>notice(e.message));};
$('sendChat').onclick=async()=>{const v=$('chatInput').value.trim();if(!v)return;const btn=$('sendChat');btn.disabled=true;notice('OpenAI wird angefragt ...');try{const d=await api('/chat','POST',{message:v,conversationId:conversationId||undefined,fileId:$('chatFile').value||undefined});$('chatInput').value='';conversationId=d.conversationId;await refreshConvos();notice(d.pendingJob?'Freigabe im Reiter „Freigaben“ erforderlich.':'Antwort erhalten');if(d.pendingJob)refreshJobs();}catch(e){notice(e.message);}finally{btn.disabled=false;}};
$('chatInput').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('sendChat').click();}};
// Die native iPhone/iPad-Hülle kann hier ein bestätigtes Sprachtranskript einsetzen.
window.bmwAIInjectTranscript=function(text){$('chatInput').value=String(text||'').slice(0,8000);$('chatInput').focus();};

// ----- Freigaben -----
const JOB_TYPES={status:'MGU-Status abfragen',diagnostic:'Systemdiagnose',list:'Verzeichnis auflisten',download:'Datei abrufen',console:'Shell-Befehl (root)',action:'Fahrzeugfunktion',faults:'Fehlerspeicher auslesen',apps:'MGU-Apps auflisten',app_logs:'App-Logs und Fehler lesen'};
const JOB_STATES={pending:'Wartet auf Freigabe',running:'Läuft',done:'Erledigt',failed:'Fehlgeschlagen',rejected:'Abgelehnt',expired:'Abgelaufen'};
function setJobBadge(count){const b=$('jobBadge');b.textContent=String(count);b.hidden=!count;}
function jobCard(j){
 const fromClaude=j.source==='claude',payload=j.payload||{},detail=payload.command||payload.path||payload.preset||payload.action||(payload.app?'App: '+payload.app+' · '+payload.lines+' Zeilen':'');
 const panel=txt('div','','panel job job-'+j.status),head=txt('div','','job-head');
 head.appendChild(txt('strong',JOB_TYPES[j.type]||j.type));
 head.appendChild(txt('span',fromClaude?'Claude':j.conversationId?'Chat':'Website','pill '+(fromClaude?'pill-claude':'pill-off')));
 head.appendChild(txt('span',(JOB_STATES[j.status]||j.status)+' · '+stamp(j.createdAt),'job-state'));
 panel.appendChild(head);
 if(detail)panel.appendChild(txt('pre',detail,'job-detail'));
 if(j.reason)panel.appendChild(txt('p',j.reason));
 if(j.status==='pending'){
  if(fromClaude)panel.appendChild(txt('p','Vorschlag von Claude. Nach deiner Freigabe wird das Ergebnis an Claude übermittelt.','hint'));
  const actions=txt('div','','actions');
  for(const choice of ['approve','reject']){
   const b=txt('button',choice==='approve'?'Einmalig freigeben':'Ablehnen',choice==='reject'?'danger':'');
   b.onclick=async()=>{
    actions.querySelectorAll('button').forEach(x=>x.disabled=true);
    try{await api('/jobs/'+j.id+'/'+choice,'POST');notice(choice==='approve'?'Auftrag ausgeführt.':'Auftrag abgelehnt.');}
    catch(e){notice(e.message);}
    await refreshJobs();
    if(choice==='approve'){refreshReports();refreshFiles();loadMessages().catch(()=>{});}
   };
   actions.appendChild(b);
  }
  panel.appendChild(actions);
 }
 if(j.status==='done'||j.status==='failed'){
  const out=j.result&&typeof j.result.stdout==='string'?j.result.stdout:JSON.stringify(j.result||j.error,null,2);
  const box=document.createElement('details');
  box.appendChild(txt('summary',j.status==='done'?'Ergebnis anzeigen':'Fehler anzeigen'));
  box.appendChild(txt('pre',String(out).slice(0,10000)));
  panel.appendChild(box);
 }
 return panel;
}
async function refreshJobs(){refreshAutoApprove();
 if(!token)return;
 try{
  const d=await api('/jobs');
  const open=d.jobs.filter(j=>j.status==='pending'||j.status==='running'),past=d.jobs.filter(j=>!open.includes(j)).slice(0,40);
  $('jobList').replaceChildren(...(open.length?open.map(jobCard):[txt('p','Keine offenen Freigaben.','hint')]));
  $('jobHistory').replaceChildren(...past.map(jobCard));
  $('jobHistoryCount').textContent=past.length?'('+past.length+')':'';
  $('jobHistoryBox').hidden=!past.length;
  setJobBadge(open.filter(j=>j.status==='pending').length);
 }catch(e){notice(e.message);}
}
$('refreshJobs').onclick=refreshJobs;
// Ein neuer Auftrag von dieser Website: gleich dorthin, wo er bestätigt wird.
async function requestJob(type,payload,reason){
 try{await api('/jobs','POST',{type,payload,reason});openTab('jobs');notice('Auftrag erstellt. Bitte prüfen und freigeben.');}
 catch(e){notice(e.message);}
}

// ----- Diagnose: Diagnosemodus für Claude -----
let lastDiagView='',lastPendingJobs=-1,lastFaultBadge=0;
function renderDiagMode(d){
 lastDiagView=JSON.stringify(d);
 const on=d.active===true;
 $('diagPill').hidden=!on;
 if(on)$('diagPill').textContent='Diagnosemodus bis '+clock(d.until);
 const state=$('diagModeState');
 state.textContent=on?'Aktiv bis '+clock(d.until)+' Uhr':'Aus';state.className='pill '+(on?'pill-live':'pill-off');
 const toggle=$('diagModeToggle');
 toggle.textContent=on?'Diagnosemodus beenden':'Diagnosemodus starten';toggle.classList.toggle('danger',on);toggle.dataset.active=on?'1':'';
 $('diagModeMinutes').disabled=on;
 $('diagModeActive').hidden=!on;
 const address=d.mcpUrl||(location.protocol==='https:'?location.origin+'/mcp':'');
 $('diagMcpUrl').value=address||'Adresse unbekannt: https://<name>.ts.net/mcp';
 $('diagCopyUrl').disabled=!address;

 const requests=$('diagRequests');requests.replaceChildren();
 if(!d.requests.length)requests.appendChild(txt('p','Keine offene Verbindungsanfrage.','hint'));
 for(const r of d.requests){
  const row=txt('div','','request'),info=txt('div','','request-info'),actions=txt('div','','actions');
  row.appendChild(txt('div',r.code,'request-code'));
  info.appendChild(txt('strong',r.client));
  info.appendChild(txt('span','Rückleitung an '+r.redirectHost+' · gültig bis '+clock(r.expiresAt),'hint'));
  row.appendChild(info);
  for(const [verb,label,cls] of [['approve','Verbindung erlauben',''],['deny','Ablehnen','danger']]){
   const b=txt('button',label,cls);
   b.onclick=async()=>{
    actions.querySelectorAll('button').forEach(x=>x.disabled=true);
    try{renderDiagMode(await api('/diag-mode/requests/'+r.id+'/'+verb,'POST'));notice(verb==='approve'?'Verbindung erlaubt. Claude übernimmt in wenigen Sekunden.':'Verbindung abgelehnt.');}
    catch(e){notice(e.message);refreshDiagMode();}
   };
   actions.appendChild(b);
  }
  row.appendChild(actions);requests.appendChild(row);
 }

 const clients=$('diagClients');clients.replaceChildren();
 if(!d.clients.length)clients.appendChild(txt('p','Noch kein Client verbunden.','hint'));
 for(const c of d.clients){
  const row=txt('div','','request'),info=txt('div','','request-info');
  info.appendChild(txt('strong',c.name));
  info.appendChild(txt('span','verbunden seit '+stamp(c.connectedAt)+(c.lastUsedAt?' · zuletzt aktiv '+stamp(c.lastUsedAt):''),'hint'));
  row.appendChild(info);
  const b=txt('button','Zugang widerrufen','danger');
  b.onclick=async()=>{b.disabled=true;try{renderDiagMode(await api('/diag-mode/clients/'+c.id+'/revoke','POST'));notice('Zugang widerrufen.');}catch(e){notice(e.message);b.disabled=false;}};
  row.appendChild(b);clients.appendChild(row);
 }

 const funnel=d.funnel||{},box=$('diagAutoFunnel'),info=$('diagFunnelInfo');
 box.checked=d.autoFunnel===true;box.disabled=false;
 info.classList.toggle('error',!!funnel.error);
 // Tailscale nennt bei fehlender Freischaltung einen Link: direkt antippbar machen.
 const link=/https:\/\/login\.tailscale\.com\/[A-Za-z0-9\/?=&._%-]+/.exec(funnel.error||''),anchor=$('diagFunnelLink');
 anchor.hidden=!link;if(link){anchor.href=link[0];anchor.textContent='Funnel bei Tailscale freischalten';}
 info.textContent=funnel.error
  ?'Tailscale meldet: '+funnel.error+' – Der Zustand von Port 443 ist unbekannt. Häufige Ursachen: fehlende Operator-Rechte des Dienstes oder Funnel ist im Tailnet noch nicht freigeschaltet (siehe README-CLAUDE-MCP.md).'
  :d.autoFunnel
   ?(funnel.public===true?'Port 443 ist bis zum Ende des Diagnosemodus öffentlich erreichbar. Öffentliche Anfragen kommen nur an die MCP-Adresse, nie an Website oder Login.':'Port 443 ist nur in deinem Tailnet erreichbar. Mit dem Start des Diagnosemodus wird er geöffnet.')
   :'Aus: Dieser Server ändert nichts an Tailscale. Ohne Funnel erreicht nur ein Client in deinem Tailnet (z. B. Claude Code) die Adresse.';
}
async function refreshDiagMode(){
 if(!token)return;
 let d;try{d=await api('/diag-mode');}catch(e){return;}
 setJobBadge(d.pendingJobs);
 if(d.pendingJobs!==lastPendingJobs){
  if(lastPendingJobs>=0&&d.pendingJobs>lastPendingJobs&&currentTab!=='jobs')notice(d.pendingClaudeJobs?'Claude bittet um eine Freigabe.':'Neue Freigabe wartet.');
  const first=lastPendingJobs<0;lastPendingJobs=d.pendingJobs;
  if(!first)refreshJobs();
 }
 if(JSON.stringify(d)!==lastDiagView)renderDiagMode(d);
 if(Date.now()-lastFaultBadge>60000){lastFaultBadge=Date.now();api('/faults').then(setFaultBadge).catch(()=>{});}
}
$('diagModeToggle').onclick=async()=>{
 const b=$('diagModeToggle'),on=b.dataset.active==='1';b.disabled=true;
 try{
  renderDiagMode(await api('/diag-mode','POST',on?{enabled:false}:{enabled:true,minutes:Number($('diagModeMinutes').value)}));
  notice(on?'Diagnosemodus beendet. Der MCP-Zugang ist geschlossen.':'Diagnosemodus gestartet.');
 }catch(e){notice(e.message);}
 finally{b.disabled=false;}
};
$('diagAutoFunnel').onchange=async()=>{
 const box=$('diagAutoFunnel');box.disabled=true;
 $('diagFunnelInfo').textContent='Tailscale wird eingestellt ...';
 try{renderDiagMode(await api('/diag-mode/funnel','POST',{auto:box.checked}));}
 catch(e){notice(e.message);lastDiagView='';await refreshDiagMode();}
};
$('diagCopyUrl').onclick=async()=>{
 try{await navigator.clipboard.writeText($('diagMcpUrl').value);notice('Adresse kopiert.');}
 catch(e){$('diagMcpUrl').select();notice('Kopieren nicht möglich – Adresse ist markiert.');}
};

// ----- Diagnose: MGU, Systemdiagnose, Berichte -----
async function refreshStatus(){
 try{
  const d=await api('/status'),on=!!(d.mgu&&d.mgu.online===true);
  $('statusResult').textContent=JSON.stringify(d,null,2);
  $('mguDot').className='dot '+(on?'is-online':'is-offline');
  $('mguText').textContent=on?'MGU verbunden'+(d.mgu.host?' ('+d.mgu.host+')':''):mguConnectionText(d);
 }catch(e){notice(e.message);}
}
$('refreshStatus').onclick=refreshStatus;
$('createDiag').onclick=()=>requestJob('diagnostic',{preset:$('preset').value},'Manuelle Diagnose '+$('preset').value);
async function refreshReports(){
 try{
  const d=await api('/reports'),root=$('reportList');root.replaceChildren();
  if(!d.reports.length)root.appendChild(txt('p','Noch keine Berichte.','hint'));
  d.reports.slice(0,60).forEach(r=>{
   const box=document.createElement('details');box.className='report';
   box.appendChild(txt('summary',r.title+' · '+stamp(r.createdAt)));
   box.appendChild(txt('p',r.source,'hint'));
   box.appendChild(txt('pre',JSON.stringify(r.result,null,2)));
   const b=txt('button','JSON herunterladen','secondary');
   b.onclick=()=>authenticatedDownload('/reports/'+r.id+'/download','diagnose-'+r.id+'.json');
   box.appendChild(b);root.appendChild(box);
  });
 }catch(e){notice(e.message);}
}
$('refreshReports').onclick=refreshReports;
function refreshDiag(){refreshDiagMode();refreshStatus();refreshReports();}

// ----- MGU mobile terminal: read-only, individually approved commands -----
let consoleHistory=[],consoleHistoryIndex=0;
const CONSOLE_TRANSCRIPT_KEY='bmw-ai-mgu-terminal-session-v1';
let consoleTranscript=[];
function consoleAddLine(content,kind){
 const root=$('consoleOutput'),line=document.createElement('div');
 line.className='console-line console-line-'+(['cmd','output','info','error','success'].includes(kind)?kind:'output');
 line.textContent=content;root.appendChild(line);root.scrollTop=root.scrollHeight;
}
function consolePrint(content,kind='output'){
 const text=String(content);
 consoleAddLine(text,kind);
 consoleTranscript.push({kind,text});
 consoleTranscript=consoleTranscript.slice(-90);
 try{sessionStorage.setItem(CONSOLE_TRANSCRIPT_KEY,JSON.stringify(consoleTranscript.map(entry=>({...entry,text:entry.text.slice(0,40000)}))));}catch(e){}
}
function consoleRestore(){
 try{
  const saved=JSON.parse(sessionStorage.getItem(CONSOLE_TRANSCRIPT_KEY)||'[]');
  if(Array.isArray(saved))consoleTranscript=saved.filter(x=>x&&typeof x.text==='string'&&typeof x.kind==='string').slice(-90);
 }catch(e){consoleTranscript=[];}
 $('consoleOutput').replaceChildren();
 if(!consoleTranscript.length)consolePrint('BMW AI MGU · root-Shell\nBefehl eingeben oder unten einen Schnellbefehl wählen.','info');
 else for(const entry of consoleTranscript)consoleAddLine(entry.text,entry.kind);
}
function consoleSetResult(message,error=false){
 const el=$('consoleResult');el.textContent=message;el.classList.toggle('is-error',error);
}
function consoleCommandSafetyProblem(command){
 if(command.length>16000)return 'Der Befehl ist zu lang (maximal 16000 Zeichen).';
 return '';
}
$('copyCommand').onclick=async()=>{
 try{await navigator.clipboard.writeText($('consoleInput').value||consoleHistory[consoleHistory.length-1]||'');}
 catch(e){consoleSetResult(e.message,true);}
};
function consoleHumanError(err){
 const raw=String(err&&err.message||err||'Unbekannter Fehler');
 if(raw.includes('MGU HTTP 400')){
  const at=raw.indexOf('{');
  if(at>=0){try{const parsed=JSON.parse(raw.slice(at));if(parsed.error)return String(parsed.error);}catch(e){}}
 }
 if(raw.includes('MGU HTTP 401'))return 'MGU-Kopplung ungültig. Bitte erneut verbinden.';
 if(raw.includes('MGU HTTP')||raw.includes('not configured')||raw.includes('fetch failed'))return 'MGU nicht erreichbar oder Anfrage abgelehnt: '+raw.slice(0,250);
 return raw.slice(0,300);
}
function consoleLock(locked){$('consoleSend').disabled=locked;$('consoleInput').disabled=locked;}
async function refreshConsoleConnection(){
 const label=$('consoleConnectionText'),dot=$('consoleDot');
 label.textContent='Prüfen …';dot.className='console-dot';
 try{
  const d=await api('/status');
  if(d.mgu&&d.mgu.online===true){label.textContent='MGU verbunden';dot.className='console-dot is-online';}
  else{label.textContent=mguConnectionText(d);dot.className='console-dot is-offline';if(d.error)consoleSetResult('Verbindung: '+consoleHumanError(d.error),true);}
 }catch(err){label.textContent='Verbindung unklar';dot.className='console-dot is-offline';consoleSetResult(consoleHumanError(err),true);}
}
$('consoleRefreshConnection').onclick=refreshConsoleConnection;
let consoleRunning=false;
$('consoleCommandForm').onsubmit=async event=>{
 event.preventDefault();
 if(consoleRunning)return;
 const command=$('consoleInput').value;
 if(!command.trim())return consoleSetResult('Gib zuerst einen Befehl ein.',true);
 const problem=consoleCommandSafetyProblem(command);
 consolePrint('mgu # '+command,'cmd');
 if(problem){consolePrint('Nicht ausgeführt: '+problem,'error');consoleSetResult(problem,true);return;}
 consoleRunning=true;consoleLock(true);consoleSetResult('Läuft …');
 consoleHistory.push(command);consoleHistory=consoleHistory.slice(-40);consoleHistoryIndex=consoleHistory.length;
 $('consoleInput').value='';
 try{
  const r=await api('/console/run','POST',{command,timeoutSec:Number($('consoleTimeout').value)||120});
  if(r.stdout)consolePrint(r.stdout,'output');
  if(r.stderr)consolePrint(r.stderr,'error');
  if(!r.stdout&&!r.stderr)consolePrint('(keine Ausgabe)','info');
  const end=r.timedOut?'Zeitlimit erreicht':r.signal?'Beendet durch '+r.signal:'Exit-Code '+r.exitCode;
  consolePrint(end+(r.truncated?' · Ausgabe gekürzt':'')+' · '+(r.durationMs/1000).toFixed(1)+' s',r.exitCode===0?'success':'error');
  consoleSetResult(end);
 }catch(err){const msg=consoleHumanError(err);consolePrint('FEHLER: '+msg,'error');consoleSetResult(msg,true);}
 finally{consoleRunning=false;consoleLock(false);$('consoleInput').focus();}
};
$('consoleInput').onkeydown=event=>{
 if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();$('consoleCommandForm').requestSubmit();}
 if(event.altKey&&event.key==='ArrowUp'&&consoleHistory.length){event.preventDefault();consoleHistoryIndex=Math.max(0,consoleHistoryIndex-1);$('consoleInput').value=consoleHistory[consoleHistoryIndex];}
 else if(event.altKey&&event.key==='ArrowDown'&&consoleHistory.length){event.preventDefault();consoleHistoryIndex=Math.min(consoleHistory.length,consoleHistoryIndex+1);$('consoleInput').value=consoleHistoryIndex===consoleHistory.length?'':consoleHistory[consoleHistoryIndex];}
};
document.querySelectorAll('[data-console-command]').forEach(button=>{
 button.onclick=()=>{
  const input=$('consoleInput');if(input.disabled)return;
  input.value=button.dataset.consoleCommand||'';input.focus();
  consoleSetResult('Befehl eingetragen.');
 };
});
$('consoleClear').onclick=()=>{
 consoleTranscript=[];$('consoleOutput').replaceChildren();
 try{sessionStorage.removeItem(CONSOLE_TRANSCRIPT_KEY);}catch(e){}
 consolePrint('Terminalverlauf geleert.','info');
};
$('consoleCopy').onclick=async()=>{
 try{await navigator.clipboard.writeText(consoleTranscript.map(e=>e.text).join('\n'));consoleSetResult('Konsolenausgabe kopiert.');}
 catch(err){consoleSetResult('Kopieren fehlgeschlagen: '+err.message,true);}
};
$('consoleExport').onclick=()=>{
 const blob=new Blob([consoleTranscript.map(e=>e.text).join('\n')+'\n'],{type:'text/plain;charset=utf-8'});
 const url=URL.createObjectURL(blob),link=document.createElement('a');
 link.href=url;link.download='bmw-ai-mgu-terminal-'+new Date().toISOString().slice(0,10)+'.txt';
 document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
 consoleSetResult('Terminalverlauf als TXT gespeichert.');
};
consoleRestore();

// ----- Fahrzeug: Kilometerstand, Fälligkeiten, Serviceheft -----
let vehicleData=null;
const kmText=n=>n===null||n===undefined?'–':Number(n).toLocaleString('de-DE')+' km';
const dateText=d=>d?new Date(d+'T12:00:00').toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'}):'–';
const MILEAGE_SOURCES={manual:'eigene Angabe',vehicle:'vom Fahrzeug',service:'aus Serviceeintrag'};
const DUE_STATES={overdue:'Überfällig',soon:'Bald fällig',ok:'In Ordnung',unknown:'Unbekannt'};
function parseKm(v){const s=String(v||'').replace(/[.\s]/g,'').replace(/km$/i,'');return s===''?null:Number(s);}
function plural(n,one,many){return n+' '+(Math.abs(n)===1?one:many);}
function dueLine(d){
 const parts=[];
 if(d.dueDate)parts.push(d.daysLeft<0?'seit '+dateText(d.dueDate)+' ('+plural(-d.daysLeft,'Tag','Tagen')+' drüber)':d.daysLeft===0?'heute':'am '+dateText(d.dueDate)+' (in '+plural(d.daysLeft,'Tag','Tagen')+')');
 if(d.dueKm!==null)parts.push(d.kmLeft===null?'bei '+kmText(d.dueKm):d.kmLeft<0?'bei '+kmText(d.dueKm)+' ('+kmText(-d.kmLeft)+' drüber)':'bei '+kmText(d.dueKm)+' (noch '+kmText(d.kmLeft)+')');
 return parts.join(' oder ');
}
function renderVehicle(v){
 vehicleData=v;
 const ccPanel=$('vehicleCheckControl');
 ccPanel.hidden=!(v.checkControl?.active.length||v.checkControl?.received.length);
 if(!ccPanel.hidden)renderCheckControl($('vehicleCheckControlList'),v.checkControl,v.poll||{});
 renderTyres(v.tyres||null);renderDpf(v.dpf||null);
 const m=v.mileage;
 const measured=v.live&&Number.isInteger(v.live.mileageKm)?v.live:null;
 $('mileageNow').textContent=measured?kmText(measured.mileageKm):m?kmText(m.km):'Noch kein Kilometerstand';
 $('mileageSource').textContent=measured?(measured.stale?'Fahrzeug · veraltet':'Fahrzeug · '+(measured.mileageSource||'Quelle unbekannt')):m?MILEAGE_SOURCES[m.source]||m.source:'–';
 $('mileageSource').className='pill '+(measured&&!measured.stale?'pill-live':'pill-off');
 $('mileageInfo').textContent=measured?[
  stamp(measured.mileageAt),measured.mileageSource||'Quelle unbekannt',
  v.mileageConflict?'Eigene Angabe: '+kmText(v.mileageConflict.manualKm)+' ('+dateText(v.mileageConflict.date)+')':null,
  m?.source==='manual'?'Wartungsplan: eigene Angabe':null,
 ].filter(Boolean).join(' · '):m?dateText(m.date):'';
 $('vehicleLive').textContent=[v.poll?.ok===true&&v.poll.appState==='running'?'Fahrzeugdaten verbunden':'Fahrzeug nicht erreichbar',
  v.poll?.lastData?'Letzter Empfang '+stamp(v.poll.lastData):null].filter(Boolean).join(' · ');
 if(!$('mileageDate').value)$('mileageDate').value=v.today;
 $('mileageDate').max=v.today;
 const hist=$('mileageHistory');hist.replaceChildren();
 if(!v.mileageHistory.length)hist.appendChild(txt('p','Noch keine Einträge.','hint'));
 const own=new Map(v.ownMileage.map(r=>[r.date+'|'+r.km+'|'+r.source,r]));
 for(const h of v.mileageHistory){
  const row=txt('div','','list-row');
  row.appendChild(txt('span',dateText(h.date)));row.appendChild(txt('strong',kmText(h.km)));
  row.appendChild(txt('span',MILEAGE_SOURCES[h.source]||h.source,'hint'));
  const rec=own.get(h.date+'|'+h.km+'|'+h.source);
  if(rec){const b=txt('button','Löschen','textbutton');b.onclick=async()=>{try{renderVehicle(await api('/vehicle/mileage/'+rec.id,'DELETE'));}catch(e){notice(e.message);}};row.appendChild(b);}
  hist.appendChild(row);
 }

 renderMaintenance(v);
 renderEntryItems(v);
 renderServiceHistory(v);
}
function renderEntryItems(v){
 const items=$('entryItems'),checked=new Set([...items.querySelectorAll('input:checked')].map(i=>i.value));
 items.replaceChildren();
 const editedEntry=v.entries.find(e=>e.id===$('entryId').value);
 const availableItems=new Set((v.activeItems||v.items).map(item=>item.id));
 for(const id of editedEntry?.items||[])availableItems.add(id);
 for(const it of v.items.filter(item=>availableItems.has(item.id))){
  const label=document.createElement('label'),checkbox=document.createElement('input');
  label.className='check';checkbox.type='checkbox';checkbox.value=it.id;checkbox.checked=checked.has(it.id);
  label.append(checkbox,document.createTextNode(' '+it.name));items.appendChild(label);
 }
}
function renderMaintenance(v){
 const box=$('dueList'),next=$('bmwNextService'),settings=v.maintenance||{};
 const select=$('maintenanceItem'),selected=select.value;
 select.replaceChildren(new Option('Neue Wartungsart',''),...v.items.map(item=>new Option(item.name,item.id)));
 select.value=selected;
 const equipment=v.equipment||{};
 $('newTransferCaseOil').hidden=!equipment.transferCase||v.items.some(item=>
  item.planKey==='transferCaseOil'||v.due.some(row=>row.id===item.id&&row.key==='transferCaseOil'));
 if(!$('itemBox').open){
  $('maintenanceProfile').querySelector('[value=legacy-plan]').hidden=settings.profile!=='legacy-plan';
  $('maintenanceProfile').value=settings.profile||'custom';
  $('maintenanceRegistration').value=settings.registration||'';
  $('maintenanceDays').value=settings.warningDays??30;
  $('maintenanceKm').value=settings.warningKm??1000;
  showMaintenanceEquipment(equipment);
 }
 const open=new Set([...box.querySelectorAll('details[open]')].map(el=>el.dataset.key));
 box.replaceChildren();next.replaceChildren();
 const cbs=(v.live?.cbs||[]).filter(c=>c.available!==false&&(c.dueDate||c.dueMonth||Number.isInteger(c.remainingKm)));
 const cbsLine=c=>[Number.isInteger(c.remainingKm)?'Noch '+kmText(c.remainingKm):'',c.dueDate?dateText(c.dueDate):c.dueMonth?.split('-').reverse().join('/')].filter(Boolean).join(' · ');
 const planLine=d=>[Number.isInteger(d.kmLeft)?(d.kmLeft<0?kmText(-d.kmLeft)+' überfällig':'Noch '+kmText(d.kmLeft)):d.dueKm!==null?'Bei '+kmText(d.dueKm):'',
  d.dueDate?dateText(d.dueDate):''].filter(Boolean).join(' · ');
 const overview=v.maintenanceOverview;
 const rows=v.due.map(d=>({d,c:cbs.find(c=>overview.cbsKeys[c.scope]===d.key)}));
 for(const c of cbs)if(!rows.some(row=>row.c===c))rows.push({c});
 const rank={overdue:0,soon:1,ok:2,unknown:3};
 const statusOf=({c,d})=>[d?.status,c?overview.cbsStatuses[c.scope]:null].filter(Boolean)
  .sort((a,b)=>rank[a]-rank[b])[0]||'unknown';
 rows.sort((a,b)=>rank[statusOf(a)]-rank[statusOf(b)]);
 next.appendChild(txt('strong','Nächster fälliger Service'));
 const bmw=v.bmwNextService||{},plan=overview.next;
 const cbsCandidates=[...new Set([bmw.byDate,bmw.byDistance].filter(Boolean).map(c=>c.label+' · '+cbsLine(c)))];
 const dateCandidate=plan.byDate?plan.byDate.name+' · '+dateText(plan.byDate.dueDate):null;
 const distanceCandidate=plan.byDistance?plan.byDistance.name+' · '+(plan.byDistance.kmLeft<0?
  kmText(-plan.byDistance.kmLeft)+' überfällig':'Noch '+kmText(plan.byDistance.kmLeft)):null;
 const planCandidates=plan.byDate&&plan.byDistance&&plan.byDate.id===plan.byDistance.id?
  [plan.byDate.name+' · '+planLine(plan.byDate)]:[dateCandidate,distanceCandidate].filter(Boolean);
 if(cbsCandidates.length)next.appendChild(txt('p',cbsCandidates.join(' / ')+' · BMW CBS'+(v.live?.cbsStale?' · veraltet':''),'hint'));
 if(planCandidates.length)next.appendChild(txt('p',planCandidates.join(' / ')+' · Wartungsplan','hint'));
 if(!cbsCandidates.length&&!planCandidates.length)next.appendChild(txt('p','Unbekannt','hint'));
 const counts=[overview.dueCount+' fällig',overview.unknownCount+' mit unbekannter Fälligkeit'];
 next.appendChild(txt('span',counts.join(' · '),'hint'));
 if(!rows.length)box.appendChild(txt('p','Wartungsprofil auswählen, um Standardintervalle anzulegen.','hint'));
 for(const {c,d} of rows){
  const status=statusOf({c,d});
  const card=txt('details','','due due-'+status);
  card.dataset.key=d?.id||c.scope;
  card.open=open.has(card.dataset.key);
  const head=txt('summary','','maintenance-row');
  const interval=d?[d.intervalKm?kmText(d.intervalKm):'',d.intervalMonths?d.intervalMonths+' Monate':''].filter(Boolean).join(' oder '):'';
  const schedule=c?cbsLine(c):planLine(d)||[interval?'Alle '+interval:null,
   ['coolant','automaticOil','rearDifferentialOil','transferCaseOil'].includes(d.key)&&!d.lastDone?'Letzter Wechsel unbekannt':'Fälligkeit unbekannt'].filter(Boolean).join(' · ');
  head.append(txt('strong',d?.name||c.label),txt('span',schedule,'hint'),
   txt('span',status==='overdue'?'Fällig':DUE_STATES[status],'pill due-pill-'+status));
  card.append(head);
  if(c)card.append(txt('p','BMW CBS'+(v.live?.cbsStale?' · veraltet':'')+(c.at?' · '+stamp(c.at):'')+(c.status!=null?' · Status '+c.status:''),'hint'));
  if(d){
   const bases={BMW:'Durch BMW-Servicehistorie bestätigt',own:'Durch eigene Wartung bestätigt',
    cycle:'Aus Servicehistorie abgeleitet',registration:'Aus Erstzulassung geschätzt'};
   const source=[d.override?'Manuell festgelegt':null,bases[d.basis]].filter(Boolean).join(' · ');
   if(source||d.dueDate||d.dueKm!=null)card.append(txt('p',[source,dueLine(d)].filter(Boolean).join(' · '),'hint'));
   if(d.cycle)card.append(txt('p','Regulärer BMW-Service am '+dateText(d.cycle.date),'hint'));
   if(d.lastDone)card.append(txt('p','Zuletzt '+dateText(d.lastDone.date)+(d.lastDone.km!==null?' · '+kmText(d.lastDone.km):'')+' · '+(d.lastDone.source==='BMW'?'BMW':'Eigene Wartung'),'hint'));
   if(interval)card.append(txt('p',(['automaticOil','rearDifferentialOil','coolant','transferCaseOil'].includes(d.key)?'Vorsorgeintervall ':'Intervall ')+interval,'hint'));
   if(d.estimatedKmDate&&d.kmLeft>0)card.append(txt('p','Geschätzte km-Grenze '+dateText(d.estimatedKmDate),'hint'));
  }
  box.append(card);
 }
}
let fullServiceHistory=false;
function renderServiceHistory(v){
 const list=$('serviceEntries'),names=Object.fromEntries(v.items.map(i=>[i.id,i.name]));
 const rows=v.history;
 list.replaceChildren();
 if(!rows.length)list.append(txt('p','Keine Serviceeinträge vorhanden.','hint'));
 const localWork=e=>[...e.items.map(id=>names[id]||'Gelöschte Wartungsart'),e.title].filter(Boolean).join(' · ');
 for(const row of fullServiceHistory?rows:rows.slice(0,5)){
  const bmw=row.bmw,card=txt('details','','service-entry'),head=txt('summary','','maintenance-row');
  const work=bmw?bmw.services.map(s=>s.label).join(' · '):localWork(row.localEntries[0]);
  const source=bmw?(row.localEntries.length?'BMW + lokal':'BMW'):'Eigene Wartung';
  head.append(txt('strong',dateText(row.date)+(row.km!=null?' · '+kmText(row.km):'')),
   txt('span',work||'Service','hint'),txt('span',source,'pill pill-off'));
  card.append(head);
  if(bmw){
   if(bmw.dealer)card.append(txt('p','Händler '+bmw.dealer,'hint'));
   const codes=bmw.services.map(s=>s.code??s.scope).filter(s=>s!==null&&s!==undefined);
   if(codes.length)card.append(txt('p',codes.join(' · '),'hint'));
   if(bmw.services.some(service=>service.referenceStatus==='external')){
    card.append(txt('p','Enthält extern dokumentierte ServiceHistory-Zuordnungen','hint'));
   }
  }
  for(const entry of row.localEntries){
   if(bmw){
    const local=[localWork(entry)||'Service',entry.date!==row.date?dateText(entry.date):null,
     entry.km!=null&&entry.km!==row.km?kmText(entry.km):null];
    card.append(txt('p','Lokale Ergänzung · '+local.filter(Boolean).join(' · '),'hint'));
   }
   for(const detail of [entry.workshop,entry.cost!=null?entry.cost.toLocaleString('de-DE',{style:'currency',currency:'EUR'}):'',entry.notes])
    if(detail)card.append(txt('p',detail,'hint'));
   const edit=txt('button','Bearbeiten','textbutton');edit.onclick=()=>editEntry(entry.id);card.append(edit);
  }
  list.append(card);
 }
 $('toggleServiceHistory').hidden=rows.length<=5;
 $('toggleServiceHistory').textContent=fullServiceHistory?'Letzte fünf Serviceeinträge anzeigen':'Gesamte Servicehistorie anzeigen';
}
$('toggleServiceHistory').onclick=()=>{fullServiceHistory=!fullServiceHistory;if(vehicleData)renderServiceHistory(vehicleData);};
$('openVehicleDiagnostics').onclick=()=>{
 openTab('diag');$('vehicleTelemetry').open=true;
 $('vehicleTelemetry').scrollIntoView({block:'start'});
};
const maintenanceEquipmentFields={automaticTransmission:'maintenanceAutoGearbox',
 rearDifferential:'maintenanceRearDifferential',transferCase:'maintenanceTransferCase'};
function showMaintenanceEquipment(equipment){
 for(const [field,id] of Object.entries(maintenanceEquipmentFields))$(id).checked=equipment[field]===true;
}
$('maintenanceProfile').onchange=()=>{
 if(vehicleData?.maintenance?.equipment)return;
 const g21=['legacy-plan','g21-diesel'].includes($('maintenanceProfile').value);
 showMaintenanceEquipment({automaticTransmission:g21,rearDifferential:g21,transferCase:$('maintenanceTransferCase').checked});
};
$('newTransferCaseOil').onclick=()=>{editItem(null);$('itemName').value='Verteilergetriebeöl';};
$('maintenanceItem').onchange=()=>editItem($('maintenanceItem').value);
$('maintenanceSettings').onsubmit=async e=>{
 e.preventDefault();
 try{renderVehicle(await api('/vehicle/maintenance','POST',{profile:$('maintenanceProfile').value,
  registration:$('maintenanceRegistration').value,warningDays:Number($('maintenanceDays').value),warningKm:Number($('maintenanceKm').value),
  equipment:Object.fromEntries(Object.entries(maintenanceEquipmentFields).map(([field,id])=>[field,$(id).checked]))}));
  notice('Wartungsprofil gespeichert.');
 }catch(err){notice(err.message);}
};
const telemetryGroups={
 'Kilometerstand':['VehicleInformation','SecureMileage','MileageSupreme','UDS.D122','UDS.D10D','UDS.1700','UDS.558E','UDS.40A3','UDS.4824'],
 'Check-Control':['CheckControlMaster','KombiInterface_2.ccListRiskClass','KombiInterface_2.ccList','KombiInterface_2.requestCCMessage','KombiInterface_2.newCCMessage','CheckControlText'],
 'BMW-Servicebedarf':['KombiInterface_2.cbsDataServiceList','ConditionBasedServicesLegacy'],
 'Servicehistorie':['ServiceHistory'],
 'Reifen':['TPMSInternalData','TPMS','UDS.DC98','UDS.DC99','UDS.DC9A','UDS.DC9B'],
 'DPF':['UDS.DPF','Diagnostics'],
 'Fehlerspeicher':['UDS.1902','Diagnostics'],
 'Fahrtenbuch (Notifier-Abos)':['Telemetry']
};
function mguConnectionText(p){
 if(p.connection==='unreachable')return 'MGU derzeit nicht erreichbar. Fahrzeug möglicherweise ausgeschaltet oder im Standby.';
 if(p.connection==='unconfigured')return 'MGU-Verbindung nicht eingerichtet.';
 if(p.connection==='agent_http_error')return p.error||'Agent hat mit einem HTTP-Fehler geantwortet.';
 if(p.connection==='invalid_response')return 'Agent-Antwort konnte nicht verarbeitet werden.';
 return p.ok||p.connection==='reachable'?'MGU-Agent erreichbar':'MGU-Verbindung noch nicht geprüft.';
}
function missingSignal(p,keys){
 const reason={unexpected_shape_or_type:'Datenstruktur oder Datentyp nicht erkannt',
  qualifier_unavailable:'BMW-Qualifier meldet keinen gültigen Wert',invalid_value:'Messwert ungültig'};
 if(p.ok===false)return mguConnectionText(p);
 const messages=[];
 for(const key of keys){
  const row=p.stages?.[key],family=p.stages?.[key.split('.')[0]];
  if(!row)continue;
  const why=reason[row.decodeReason]||(row.responseReceived&&row.decoded===false?'Antwort nicht auswertbar':
    row.manifestRead===false&&row.manifestSubscribe!==true?'Getter nicht im Manifest freigegeben':
    row.getter==='waiting_provider'?'Wartet auf den SOME/IP-Provider':
    row.getter==='not_configured'?'Getter in der installierten Proxy-Konfiguration fehlt':
    ['failed','paused'].includes(row.getter)?'Getter antwortet nicht erfolgreich':
    family?.provider===false?'Provider nicht erreichbar':
    row.subscription==='failed'?'Subscription fehlgeschlagen':null);
  if(why)messages.push(key+' · '+why);
 }
 return messages.join(' / ');
}
$('faultEcuWorksheet').onclick=async()=>{
 try{triggerFileDownload(new Blob([JSON.stringify(await api('/faults/ecu-worksheet'),null,2)],{type:'application/json'}),'bmw-ecu-identities.json');}
 catch(e){notice(e.message);}
};
async function renderTelemetry(){
 try{
  const data=await api('/vehicle/diagnostics'),p=data.poll||{},box=$('vehicleTelemetryRows');
  const times=$('dpfMeasurementTimes');
  times.replaceChildren(...Object.entries(data.dpfFieldTimes||{}).map(([field,at])=>txt('p','DPF · '+field+' · '+stamp(at),'hint')));
  const transfer=p.transfer||{},versions=p.versions||{};
  const installed=(versions.vehicleDataInstalled||[]).map(app=>app.version).join(', ');
  box.replaceChildren(txt('p',p.ok?'Snapshot empfangen · '+stamp(p.lastOk):'Übertragung unterbrochen oder noch ungeprüft','hint'));
  box.appendChild(txt('p',['Pi '+(versions.pi||'unbekannt'),'Agent '+(versions.agent||'unbekannt'),
   'Vehicle Data installiert '+(installed||'unbestätigt'),'Snapshot-Version '+(versions.vehicleDataRunning||'unbekannt')].join(' · '),'hint'));
  box.appendChild(txt('p',[
   transfer.snapshotAt?'Snapshot geschrieben '+stamp(transfer.snapshotAt):'Snapshotzeit fehlt',
   transfer.agentForwardedAt?'Agent übertragen '+stamp(transfer.agentForwardedAt):'Agent-Zeit fehlt',
   transfer.piReceivedAt?'Pi empfangen '+stamp(transfer.piReceivedAt):null,
   transfer.piPersistedAt?'Pi Diagnose gespeichert '+stamp(transfer.piPersistedAt):'Pi Speicherung nicht bestätigt'
  ].filter(Boolean).join(' · '),'hint'));
  for(const [label,sources] of Object.entries(telemetryGroups)){
   const section=txt('div','','service-entry');
   section.appendChild(txt('strong',label));
   if(label==='Check-Control'&&data.checkControl){
    const cc=data.checkControl;
    if(cc.listAt)section.appendChild(txt('p','Letzte vollständige Liste '+stamp(cc.listAt)+' · '+cc.source,'hint'));
    for(const [source,row] of Object.entries(cc.receipts||{})){
     const reasons=Object.entries(row.reasons||{}).map(([reason,count])=>reason+' '+count).join(', ');
     section.appendChild(txt('p',[source,row.origin,row.shape,row.length==null?null:row.length+' Elemente',
      row.valid+' gültig',row.rejected+' verworfen',reasons,row.authoritative?'vollständig übernommen':'kein vollständiger Abgleich',stamp(row.at)]
      .filter(Boolean).join(' · '),'hint'));
    }
   }
   if(label==='Kilometerstand'&&data.mileageIngest)section.appendChild(txt('p','Pi · '+data.mileageIngest,'hint'));
   const keys=[...Object.keys(p.received||{}),...Object.keys(p.stages||{})].filter(k=>sources.some(src=>k===src||k.startsWith(src+'.')));
   for(const key of [...new Set([...sources,...keys])]){
    const family=key.split('.')[0],signal=(p.signals||{})[key]||(p.signals||{})[family],r=(p.received||{})[key];
    const stage={...p.stages?.[family],...p.stages?.[key]},yesNo=v=>v===true?'ja':v===false?'nein':'–';
    const states={config_missing_or_invalid:'Konfiguration fehlt oder ist ungültig',config_loaded:'Konfiguration geladen',
     native_unavailable:'SOME/IP-Bibliothek fehlt',not_configured:'Getter fehlt',not_requested:'entfällt',
     pending:'läuft',ok:'erfolgreich',failed:'fehlgeschlagen',paused:'nach 3 Fehlern pausiert',waiting_provider:'wartet auf Provider'};
    if(typeof stage.manifestRead==='boolean'||stage.manifestMethod||stage.interface||stage.getter){
     const stages=[
      typeof stage.manifestRead==='boolean'?'Manifest Lesen '+yesNo(stage.manifestRead)+' / Abo '+yesNo(stage.manifestSubscribe):null,
      stage.manifestMethod?'Methode im Manifest':null,
      stage.interface?states[stage.interface]:null,
      typeof stage.provider==='boolean'?'Provider '+yesNo(stage.provider):null,
      stage.initialGetter?'Initialabruf '+states[stage.initialGetter]:null,
      stage.getter?'Letzter Abruf '+states[stage.getter]:null,
      stage.getterFailure?'Getter-Fehler '+stage.getterFailure:null,
      typeof stage.providerAtFailure==='boolean'?'Provider beim Fehler '+yesNo(stage.providerAtFailure):null,
      stage.decodeReason?'Dekodierung: '+stage.decodeReason:null,
      stage.subscription?'Abo '+states[stage.subscription]:null,
      'Antwort '+yesNo(stage.responseReceived),'Dekodiert '+yesNo(stage.decoded)
     ].filter(Boolean).join(' · ');
     section.appendChild(txt('p',key+' · '+stages,'hint'));
    }
    if(stage.odometer){
     const o=stage.odometer,hex=n=>Number.isInteger(n)?n.toString(16).toUpperCase().padStart(2,'0'):'–';
     const summary=['ECU 0x'+hex(o.ecu),o.request?.map(hex).join(' '),String(o.actualLength??'–')+'/'+o.expectedLength+' Nutzbytes',
      o.nrc!=null?'NRC 0x'+hex(o.nrc):null,o.rule,o.payload,o.km!=null?kmText(o.km):null,
      o.eepromKm!=null?'EEPROM '+kmText(o.eepromKm):null,o.warning==='ram_eeprom_difference'?'RAM/EEPROM weichen ab':null,
      o.historical?'Nur FEPM-Historie':null,Number.isInteger(o.failures)?o.failures+' Fehler in Folge':null,
      stamp(o.lastSuccess?new Date(o.lastSuccess).toISOString():null)?'Letzter Erfolg '+stamp(new Date(o.lastSuccess).toISOString()):null,stamp(o.at)].filter(Boolean).join(' · ');
     section.appendChild(txt('p',key+' · '+summary,'hint'));
    }
    const meta=[signal?(signal.available?'Schnittstelle verfügbar':'Schnittstelle nicht bestätigt'):null,
      r?'Empfangen '+stamp(r.at):null,r?.validAt?'Gültig '+stamp(r.validAt)+' · '+r.count+' Datensätze':null,
      r&&r.valid===false?'Letzte Antwort nicht auswertbar':null,signal?.error?'Letzter Fehler · '+signal.error+(signal.errorAt?' · '+stamp(signal.errorAt):''):null].filter(Boolean);
    section.appendChild(txt('p',key+' · '+(meta.join(' · ')||'Noch keine Rückmeldung'),'hint'));
   }
   box.appendChild(section);
  }
 }catch(e){$('vehicleTelemetryRows').textContent=e.message;}
}
$('vehicleTelemetry').ontoggle=()=>{if($('vehicleTelemetry').open)renderTelemetry();};
$('vehicleTelemetryExport').onclick=async()=>{
 try{triggerFileDownload(new Blob([JSON.stringify(await api('/vehicle/diagnostics?capabilities=1'),null,2)],{type:'application/json'}),'bmw-vehicle-diagnostics.json');}
 catch(e){notice(e.message);}
};

setInterval(async()=>{
 if(!token||document.hidden)return;
 if(currentTab==='faults'&&!$('faultRead').disabled)refreshFaults();
 if(currentTab==='diag'&&$('vehicleTelemetry').open)renderTelemetry();
 if(currentTab==='vehicle'&&!$('vehicle').contains(document.activeElement)){
  try{
   const current=await api('/vehicle');
   if(currentTab==='vehicle'){
    renderVehicle(current);

   }
  }catch(e){$('vehicleLive').textContent=e.message;}
 }
},30000);
async function refreshVehicle(){
 if(!token)return;
 try{renderVehicle(await api('/vehicle'));}catch(e){notice(e.message);}
 // Liefert der MGU-Agent einen Kilometerstand, übernimmt der Server ihn dabei.
 try{
  await api('/status');
  renderVehicle(await api('/vehicle'));

 }catch(e){$('vehicleLive').textContent='Live-Daten nicht abrufbar: '+e.message;}
}
$('refreshVehicle').onclick=refreshVehicle;
$('addMileage').onclick=async()=>{
 const km=parseKm($('mileageKm').value);if(km===null||!Number.isInteger(km))return notice('Bitte den Kilometerstand als ganze Zahl eingeben.');
 try{renderVehicle(await api('/vehicle/mileage','POST',{km,date:$('mileageDate').value||undefined}));$('mileageKm').value='';notice('Kilometerstand gespeichert.');}catch(e){notice(e.message);}
};
$('mileageKm').onkeydown=e=>{if(e.key==='Enter')$('addMileage').click();};
function editItem(id){
 const it=vehicleData&&vehicleData.items.find(i=>i.id===id);
 $('maintenanceItem').value=it?it.id:'';
 $('itemId').value=it?it.id:'';$('itemName').value=it?it.name:'';
 $('itemMonths').value=it?it.intervalMonths||0:'';$('itemKm').value=it?it.intervalKm||0:'';
 const d=it&&vehicleData.due.find(x=>x.id===id),o=d?d.override:it?.override;
 $('itemDueDate').value=o&&o.date||'';$('itemDueKm').value=o&&o.km!==null&&o.km!==undefined?o.km:'';
 $('itemDelete').hidden=!it;$('itemBox').open=true;$('itemName').focus();
}
$('itemCancel').onclick=()=>editItem(null);
$('itemForm').onsubmit=async e=>{
 e.preventDefault();
 const num=v=>v===''?0:Number(v);
 try{
  renderVehicle(await api('/vehicle/items','POST',{id:$('itemId').value||undefined,name:$('itemName').value,intervalMonths:num($('itemMonths').value),intervalKm:num($('itemKm').value),dueDate:$('itemDueDate').value||null,dueKm:$('itemDueKm').value===''?null:Number($('itemDueKm').value)}));
  notice('Wartungsart gespeichert.');editItem(null);$('itemBox').open=false;
 }catch(err){notice(err.message);}
};
$('itemDelete').onclick=async()=>{const id=$('itemId').value;if(!id)return;try{renderVehicle(await api('/vehicle/items/'+id,'DELETE'));editItem(null);$('itemBox').open=false;}catch(e){notice(e.message);}};
function editEntry(id){
 const e=id&&vehicleData?vehicleData.entries.find(x=>x.id===id):null;
 $('serviceForm').hidden=false;$('entryId').value=e?e.id:'';
 if(vehicleData)renderEntryItems(vehicleData);
 $('entryDate').value=e?e.date:vehicleData?vehicleData.today:'';
 $('entryKm').value=e&&e.km!==null?e.km:vehicleData&&vehicleData.mileage?vehicleData.mileage.km:'';
 $('entryTitle').value=e?e.title:'';$('entryWorkshop').value=e?e.workshop:'';$('entryNotes').value=e?e.notes:'';
 $('entryCost').value=e&&e.cost!==null?String(e.cost).replace('.',','):'';
 $('entryItems').querySelectorAll('input').forEach(c=>c.checked=!!e&&e.items.includes(c.value));
 $('entryDelete').hidden=!e;$('entryDate').focus();
}
$('newServiceEntry').onclick=()=>editEntry(null);
$('entryCancel').onclick=()=>{$('serviceForm').hidden=true;};
$('serviceForm').onsubmit=async e=>{
 e.preventDefault();
 const km=parseKm($('entryKm').value);
 try{
  renderVehicle(await api('/vehicle/entries','POST',{id:$('entryId').value||undefined,date:$('entryDate').value,km,items:[...$('entryItems').querySelectorAll('input:checked')].map(c=>c.value),
   title:$('entryTitle').value,workshop:$('entryWorkshop').value,notes:$('entryNotes').value,cost:$('entryCost').value}));
  $('serviceForm').hidden=true;notice('Serviceeintrag gespeichert.');
 }catch(err){notice(err.message);}
};
$('entryDelete').onclick=async()=>{const id=$('entryId').value;if(!id||!confirmInline($('entryDelete')))return;try{renderVehicle(await api('/vehicle/entries/'+id,'DELETE'));$('serviceForm').hidden=true;}catch(e){notice(e.message);}};
// Zweimal tippen statt Browser-Dialog: erster Tipp fragt nach, zweiter löscht.
function confirmInline(button){
 if(button.dataset.armed==='1'){button.dataset.armed='';button.textContent=button.dataset.label;return true;}
 button.dataset.label=button.textContent;button.dataset.armed='1';button.textContent='Wirklich löschen?';
 setTimeout(()=>{if(button.dataset.armed==='1'){button.dataset.armed='';button.textContent=button.dataset.label;}},4000);return false;
}

// ----- Dateien: MGU-Browser, gefundene Logs, Bibliothek -----
let mguRootsList=[],mguCurrent='',libraryFiles=[];
const sizeText=b=>b===undefined||b===null?'':b<1024?b+' B':b<1048576?(b/1024).toFixed(1).replace('.',',')+' KB':(b/1048576).toFixed(1).replace('.',',')+' MB';
const isLogName=n=>/(?:\.(?:log|logs|txt|out|err|trace|dlt|journal)(?:\.\d+)?(?:\.gz)?|\.log\.\d+|_log)$/i.test(n);
const fileKind=f=>f.kind||(String(f.source||'').startsWith('MGU:')?'mgu':'upload');
async function fetchFromMgu(p,kind,button){
 if(button)button.disabled=true;
 try{
  const d=await api('/mgu/fetch','POST',{path:p,kind});
  notice(d.duplicate?'Schon in der Bibliothek, unverändert.':kind==='log'?'Als Log gespeichert.':'In die Bibliothek geholt.');
  refreshFiles();if(kind==='log')refreshFoundLogs();
  return d.file;
 }catch(e){notice(e.message);return null;}
 finally{if(button)button.disabled=false;}
}
function mguFileRow(fullPath,entry){
 const row=txt('div','','list-row'),name=entry.name;
 const info=txt('div','','request-info');
 info.appendChild(txt('strong',name));
 info.appendChild(txt('span',[entry.kind,sizeText(entry.bytes),stamp(entry.mtime)].filter(Boolean).join(' · '),'hint'));
 row.appendChild(info);
 if(entry.kind==='directory'||entry.kind==='symlink'){
  const b=txt('button','Öffnen','linkbutton');b.onclick=()=>browseMgu(fullPath);row.appendChild(b);
 }
 if(entry.kind==='file'){
  const dl=txt('button','Herunterladen','secondary');
  dl.onclick=async()=>{
   dl.disabled=true;
   try{
    if(entry.bytes>16*1024*1024){
     const ticket=await api('/mgu/download-ticket','POST',{path:fullPath});
     const link=document.createElement('a');
     link.href=ticket.url;link.download=fullPath.split('/').pop();link.rel='noreferrer';
     document.body.appendChild(link);link.click();link.remove();
     notice('Übertragung an den Download-Manager übergeben.');
     return;
    }
    const response=await fetch('/api/v1/mgu/download?path='+encodeURIComponent(fullPath),{headers:authHeaders(),signal:AbortSignal.timeout(605000)});
    if(!response.ok)throw Error((await response.json()).error||'HTTP '+response.status);
    const length=Number(response.headers.get('content-length')),reader=response.body.getReader(),chunks=[];
    let bytes=0;
    while(true){
     const result=await reader.read();if(result.done)break;
     chunks.push(result.value);bytes+=result.value.length;
     dl.textContent=sizeText(bytes)+(length?' / '+sizeText(length):'');
    }
    if(bytes!==length)throw Error('Download wurde unvollständig übertragen');
    triggerFileDownload(new Blob(chunks),fullPath.split('/').pop());
    notice('Datei vollständig an den Browser übertragen.');
   }catch(e){notice(e.message);}
   finally{dl.disabled=false;dl.textContent='Herunterladen';}
  };
  const save=txt('button','Auf Pi speichern','textbutton');
  save.onclick=()=>fetchFromMgu(fullPath,isLogName(name)||fullPath.startsWith('/var/log/')?'log':'mgu',save);
  row.append(dl,save);
 }
 return row;
}
let browseSequence=0,mguListing=null,mguFavorites=[];
function renderMguListing(){
 const box=$('mguListing'),d=mguListing;
 if(!d)return;
 box.replaceChildren();
 const sort=$('mguSort').value;
 const entries=[...d.entries].sort((a,b)=>sort==='bytes'?a.bytes-b.bytes:String(a[sort]||'').localeCompare(String(b[sort]||'')));
 for(const e of entries)box.appendChild(mguFileRow(d.file?d.path:d.path.replace(/\/$/,'')+'/'+e.name,e));
 if(!entries.length)box.appendChild(txt('p','Keine passenden Einträge.','hint'));
 if(d.skipped)box.appendChild(txt('p',d.skipped+' Einträge konnten nicht gelesen werden.','hint'));
 if(d.next!==null&&d.next!==undefined){
  const more=txt('button','Nächste Seite','secondary');
  more.onclick=()=>browseMgu(d.path,d.term,d.recursive,d.next);box.appendChild(more);
 }else if(d.truncated)box.appendChild(txt('p','Suchgrenze erreicht. Gib einen genaueren Suchbegriff ein.','hint'));
}
async function browseMgu(p,term='',recursive=false,offset=0){
 const box=$('mguListing'),serial=++browseSequence;
 box.replaceChildren(txt('p','Lade '+p+' …','hint'));
 mguListing=null;
 try{
  const d=await api('/mgu/browse','POST',{path:p,term,recursive,offset});
  if(serial!==browseSequence)return;
  mguCurrent=d.path||p;$('mguPathInput').value=mguCurrent;
  $('mguCrumbs').textContent=mguCurrent;
  mguListing={...d,term,recursive};renderMguListing();
 }catch(e){if(serial===browseSequence)box.replaceChildren(txt('p',e.message,'error'));}
}
$('mguOpen').onclick=()=>browseMgu($('mguPathInput').value.trim());
$('mguPathInput').onkeydown=e=>{if(e.key==='Enter')$('mguOpen').click();};
$('mguParent').onclick=()=>browseMgu(mguCurrent.slice(0,mguCurrent.lastIndexOf('/'))||'/');
$('mguSort').onchange=renderMguListing;
$('mguSearch').onclick=()=>browseMgu(($('mguPathInput').value||mguCurrent).trim(),$('mguSearchTerm').value.trim(),$('mguRecursive').checked);
$('mguSearchTerm').onkeydown=e=>{if(e.key==='Enter')$('mguSearch').click();};
function showFavorites(data){
 mguFavorites=data.favorites;
 const sel=$('mguFavorites'),previous=sel.value;
 sel.replaceChildren(new Option('Favoriten',''),...mguFavorites.map(f=>new Option(f.name,f.id)));
 if(mguFavorites.some(f=>f.id===previous))sel.value=previous;
}
const selectedFavorite=()=>mguFavorites.find(f=>f.id===$('mguFavorites').value);
$('mguFavorites').onchange=()=>{const f=selectedFavorite();if(f)browseMgu(f.path);};
$('favoriteAdd').onclick=async()=>{
 const name=prompt('Name des Favoriten');
 if(!name)return;
 try{showFavorites(await api('/mgu/favorites','POST',{name,path:$('mguPathInput').value.trim()}));}catch(e){notice(e.message);}
};
$('favoriteRename').onclick=async()=>{
 const f=selectedFavorite();if(!f)return notice('Wähle einen Favoriten.');
 const name=prompt('Neuer Name',f.name);if(!name)return;
 try{showFavorites(await api('/mgu/favorites','POST',{id:f.id,name}));}catch(e){notice(e.message);}
};
$('favoriteDelete').onclick=async()=>{
 const f=selectedFavorite();if(!f)return notice('Wähle einen Favoriten.');
 if(!confirm('Favorit „'+f.name+'“ löschen?'))return;
 try{showFavorites(await api('/mgu/favorites','DELETE',{id:f.id}));}catch(e){notice(e.message);}
};
async function loadMguRoots(){
 try{
  showFavorites(await api('/mgu/favorites'));
  if(mguRootsList.length)return;
  mguRootsList=(await api('/mgu/roots')).roots;
  const chips=$('mguRoots');chips.replaceChildren();
  for(const r of mguRootsList){const b=txt('button',r,'console-chip');b.onclick=()=>browseMgu(r);chips.appendChild(b);}
 }catch(e){notice(e.message);}
}
const FOUND_STATES={new:'Neu',queued:'Wird geholt',saving:'Wird geholt',saved:'Gespeichert',failed:'Fehlgeschlagen',ignored:'Ignoriert'};
const FOUND_BY={claude:'Claude',manual:'du'};
async function refreshFoundLogs(){
 try{
  const d=await api('/found-logs'),box=$('foundLogs');
  $('foundLogsAuto').checked=d.auto;$('foundLogsAuto').disabled=false;box.replaceChildren();
  const visible=d.found.filter(f=>f.status!=='ignored');
  if(!visible.length)box.appendChild(txt('p','Noch keine gefundenen Logs.','hint'));
  for(const f of visible){
   const row=txt('div','','list-row'),info=txt('div','','request-info');
   info.appendChild(txt('span',f.path));
   info.appendChild(txt('span',[FOUND_STATES[f.status]||f.status,'gefunden von '+(FOUND_BY[f.foundBy]||f.foundBy),stamp(f.foundAt),sizeText(f.bytes),f.note||'',f.error||''].filter(Boolean).join(' · '),'hint'+(f.status==='failed'?' error':'')));
   row.appendChild(info);
   if(f.status==='saved'&&f.fileId){const b=txt('button','Herunterladen','secondary');b.onclick=()=>authenticatedDownload('/files/'+f.fileId+'/download',f.path.split('/').pop());row.appendChild(b);}
   if(['new','failed','saved'].includes(f.status)){
    const s=txt('button',f.status==='saved'?'Neu holen':'Hinzufügen',f.status==='saved'?'textbutton':'');
    s.onclick=async()=>{s.disabled=true;try{await api('/found-logs/'+f.id+'/save','POST');refreshFiles();}catch(e){notice(e.message);}refreshFoundLogs();};row.appendChild(s);
   }
   if(f.status==='new'||f.status==='failed'){const i=txt('button','Ignorieren','textbutton');i.onclick=async()=>{try{await api('/found-logs/'+f.id+'/ignore','POST');}catch(e){notice(e.message);}refreshFoundLogs();};row.appendChild(i);}
   box.appendChild(row);
  }
  const hidden=d.found.length-visible.length;if(hidden)box.appendChild(txt('p',hidden+' ignoriert','hint'));
  if(d.found.some(f=>f.status==='queued'||f.status==='saving'))setTimeout(()=>{if(currentTab==='files'){refreshFoundLogs();refreshFiles();}},3000);
 }catch(e){notice(e.message);}
}
$('refreshFoundLogs').onclick=refreshFoundLogs;
$('foundLogsAuto').onchange=async()=>{const box=$('foundLogsAuto');box.disabled=true;try{await api('/found-logs/settings','POST',{auto:box.checked});notice(box.checked?'Gefundene Logs werden automatisch geholt.':'Gefundene Logs holst du per Klick.');}catch(e){notice(e.message);}refreshFoundLogs();};
function renderLibrary(){
 const q=$('librarySearch').value.trim().toLowerCase(),kind=$('libraryFilter').value,box=$('libraryList');box.replaceChildren();
 const shown=libraryFiles.filter(f=>(!kind||fileKind(f)===kind)&&(!q||(f.name+' '+(f.mguPath||f.source||'')).toLowerCase().includes(q)));
 if(!shown.length)box.appendChild(txt('p',libraryFiles.length?'Keine Treffer.':'Noch keine Dateien.','hint'));
 for(const f of shown){
  const row=txt('div','','list-row'),info=txt('div','','request-info');
  const title=txt('span','');title.appendChild(txt('strong',f.name));if(fileKind(f)==='log')title.appendChild(txt('span','Log','pill pill-off'));
  info.appendChild(title);info.appendChild(txt('span',[sizeText(f.bytes),f.mguPath||f.source,stamp(f.at)].filter(Boolean).join(' · '),'hint'));
  row.appendChild(info);
  const b=txt('button','Herunterladen','secondary');b.onclick=()=>authenticatedDownload('/files/'+f.id+'/download',f.name);row.appendChild(b);
  const del=txt('button','Löschen','textbutton');del.onclick=async()=>{if(!confirmInline(del))return;try{await api('/files/'+f.id,'DELETE');refreshFiles();refreshFoundLogs();}catch(e){notice(e.message);}};row.appendChild(del);
  box.appendChild(row);
 }
}
$('librarySearch').oninput=renderLibrary;$('libraryFilter').onchange=renderLibrary;
async function refreshFiles(){
 try{
  const d=await api('/files'),select=$('chatFile'),previous=select.value;libraryFiles=d.files;
  select.replaceChildren(new Option('Ohne Datei',''));
  d.files.filter(f=>/\.(txt|json|log|xml|csv|md|ini|conf)$/i.test(f.name)&&f.bytes<=131072).forEach(f=>select.appendChild(new Option('Datei analysieren: '+f.name,f.id)));
  select.value=previous;renderLibrary();
 }catch(e){notice(e.message);}
}
function refreshFilesTab(){loadMguRoots();refreshFoundLogs();refreshFiles();}
$('uploadBtn').onclick=async()=>{const f=$('upload').files[0];if(!f)return notice('Datei auswählen');if(f.size>8*1024*1024)return notice('Maximal 8 MiB');try{const r=await fetch('/api/v1/files?name='+encodeURIComponent(f.name),{method:'POST',headers:authHeaders(),body:f});if(!r.ok)throw Error('Upload HTTP '+r.status);notice('Datei hochgeladen');refreshFiles();}catch(e){notice(e.message);}};

// ----- Local import of selected ChatGPT-export conversations -----
let exportChats=[],pendingUpdate=null;
$('openChatImport').onclick=()=>{$('chatImportPanel').hidden=false;$('chatImportStatus').textContent='Öffne die Datei conversations.json aus deinem ChatGPT-Datenexport.';};
$('closeChatImport').onclick=()=>{$('chatImportPanel').hidden=true;exportChats=[];$('chatExport').value='';$('chatImportList').replaceChildren();};
function flattenExportConversation(c){
  let messages=[],nodes=c.mapping||{};
  if(c.current_node&&nodes[c.current_node]){
    let id=c.current_node,seen=new Set(),chain=[];
    while(id&&nodes[id]&&!seen.has(id)&&chain.length<4000){seen.add(id);chain.unshift(nodes[id]);id=nodes[id].parent;}
    messages=chain.map(n=>n.message).filter(Boolean);
  }else if(Array.isArray(c.messages))messages=c.messages;
  else messages=Object.values(nodes).map(n=>n.message).filter(Boolean).sort((a,b)=>(a.create_time||0)-(b.create_time||0));
  return messages.map(m=>{
    const role=m.author?.role||m.role;const content=m.content||{};
    let chunks=Array.isArray(content.parts)?content.parts.filter(x=>typeof x==='string'):[];
    if(!chunks.length&&typeof content.text==='string')chunks=[content.text];
    if(!chunks.length&&typeof m.text==='string')chunks=[m.text];
    return {role,content:chunks.join('\n').slice(0,6000)};
  }).filter(m=>['user','assistant'].includes(m.role)&&m.content.trim()).slice(-180);
}
function drawImportCandidates(){
  const root=$('chatImportList');root.replaceChildren();const term=$('chatImportSearch').value.trim().toLowerCase();
  const rows=exportChats.filter(c=>(c.title||'').toLowerCase().includes(term)).slice(0,160);
  for(const c of rows){const m=c._messages;const label=document.createElement('label');label.className='import-choice';
    const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.dataset.id=c._id;
    label.appendChild(checkbox);label.appendChild(txt('span',(c.title||'Ohne Titel')+' · '+m.length+' Textnachrichten'));
    root.appendChild(label);
  }
  $('chatImportStatus').textContent=rows.length+' passende Chats. ChatGPT-Projektzuordnung ist im Export nicht garantiert; bitte nur deine gewünschten MGU-Chats auswählen.';
}
$('chatExport').onchange=async()=>{
  const file=$('chatExport').files[0];if(!file)return;
  if(file.size>120*1024*1024){$('chatImportStatus').textContent='Export zu groß (>120 MiB). Bitte auf einem Computer einen kleineren JSON-Auszug erstellen.';return;}
  try{const obj=JSON.parse(await file.text());const items=Array.isArray(obj)?obj:obj.conversations;
    if(!Array.isArray(items))throw Error('Keine conversations.json erkannt');
    exportChats=items.map((c,i)=>({...c,_id:String(c.id||c.conversation_id||'export-'+i),_messages:flattenExportConversation(c)})).filter(c=>c._messages.length);
    drawImportCandidates();
  }catch(e){$('chatImportStatus').textContent='Importfehler: '+e.message;exportChats=[];}
};
$('chatImportSearch').oninput=drawImportCandidates;
$('importSelectedChats').onclick=async()=>{
  const ids=Array.from($('chatImportList').querySelectorAll('input:checked')).map(x=>x.dataset.id);
  if(!ids.length)return notice('Bitte zunächst gewünschte Chats markieren.');
  const btn=$('importSelectedChats');btn.disabled=true;let count=0,failed=[];
  try{for(const id of ids){const c=exportChats.find(x=>x._id===id);if(!c)continue;
      try{const r=await api('/conversations/import','POST',{externalId:c._id,title:c.title||'ChatGPT-Import',messages:c._messages});if(!r.alreadyImported)count++;}
      catch(e){failed.push((c.title||c._id)+': '+e.message);}
    }
    $('chatImportStatus').textContent=count+' Chats importiert.'+(failed.length?' Fehler: '+failed.join('; '):'')+' Du kannst sie im Auswahlfeld öffnen und lokal weiterführen.';
    await refreshConvos();
  }finally{btn.disabled=false;}
};

// ----- Owner-controlled return export to ChatGPT project conversations -----
let chatExportCandidates=[],chosenChatExports=new Set();
function exportChoices(){
 const filter=$('chatExportSearch').value.trim().toLowerCase(),root=$('chatExportList');
 root.replaceChildren();
 const visible=chatExportCandidates.filter(c=>String(c.title||'').toLowerCase().includes(filter)).slice(0,150);
 for(const c of visible){
   const row=document.createElement('label');row.className='import-choice';
   const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=chosenChatExports.has(c.id);
   checkbox.onchange=()=>{if(checkbox.checked)chosenChatExports.add(c.id);else chosenChatExports.delete(c.id);};
   row.appendChild(checkbox);
   row.appendChild(txt('span',(c.importSource==='ChatGPT'?'[ChatGPT-Import] ':'')+(c.title||'Ohne Titel')));
   root.appendChild(row);
 }
 $('chatExportResult').textContent=chosenChatExports.size+' Chat(s) ausgewählt. Ein Export darf höchstens 25 Chats enthalten.';
}
async function refreshChatExportOptions(){
 try{
   const p=await api('/conversations/export/automatic');
   $('autoChatExport').checked=p.enabled===true;
   $('chatExportInfo').textContent=p.available?'Lokale Kopie zuletzt erstellt: '+p.updatedAt:'Noch keine lokale Exportkopie vorhanden.';
 }catch(e){$('chatExportInfo').textContent='Auto-Export: '+e.message;}
}
$('openChatExport').onclick=async()=>{
 $('chatExportPanel').hidden=false;
 try{
   const d=await api('/conversations');chatExportCandidates=d.conversations;
   if(!chosenChatExports.size&&conversationId)chosenChatExports.add(conversationId);
   exportChoices();await refreshChatExportOptions();
 }catch(e){$('chatExportResult').textContent='Chats konnten nicht geladen werden: '+e.message;}
};
$('closeChatExport').onclick=()=>{$('chatExportPanel').hidden=true;};
$('chatExportSearch').oninput=exportChoices;
$('markAllExportChats').onclick=()=>{
 const filter=$('chatExportSearch').value.trim().toLowerCase();
 chosenChatExports=new Set(chatExportCandidates.filter(c=>String(c.title||'').toLowerCase().includes(filter)).slice(0,25).map(c=>c.id));
 exportChoices();
};
$('markNoExportChats').onclick=()=>{chosenChatExports.clear();exportChoices();};
function chatExportRequest(){
 const ids=Array.from(chosenChatExports);
 if(!ids.length||ids.length>25)throw Error('Bitte 1 bis 25 Chats markieren.');
 return {ids,scope:$('chatExportNewOnly').checked?'new':'full',format:$('chatExportFormat').value};
}
async function generateChatExport(share){
 const data=chatExportRequest(),button=$(share?'shareExportChats':'exportSelectedChats');
 button.disabled=true;
 try{
   $('chatExportResult').textContent='Export wird zusammengestellt ...';
   const r=await fetch('/api/v1/conversations/export',{method:'POST',
     headers:{...authHeaders(),'content-type':'application/json'},body:JSON.stringify(data),cache:'no-store'});
   if(!r.ok){const e=await r.json().catch(()=>({}));throw Error(e.error||'HTTP '+r.status);}
   const bytes=await r.blob(),extension=data.format==='json'?'json':'md';
   const name='bmw-ai-chats-'+new Date().toISOString().slice(0,10)+'.'+extension;
   if(share&&navigator.share){
     const file=new File([bytes],name,{type:data.format==='json'?'application/json':'text/markdown'});
     if(!navigator.canShare||navigator.canShare({files:[file]})){
       try{await navigator.share({files:[file],title:'BMW AI Chats für ChatGPT'});$('chatExportResult').textContent='Datei geteilt. Du kannst sie im gewünschten ChatGPT-Projekt als Kontext hochladen.';return;}
       catch(e){if(e.name==='AbortError'){$('chatExportResult').textContent='Teilen abgebrochen. Keine Daten an ChatGPT übermittelt.';return;}}
     }
   }
   triggerFileDownload(bytes,name);
   $('chatExportResult').textContent='Datei heruntergeladen. Öffne dein ChatGPT-Projekt und füge sie dem gewünschten Chat als Anhang hinzu.';
 }catch(e){$('chatExportResult').textContent='Export fehlgeschlagen: '+e.message;}
 finally{button.disabled=false;}
}
$('exportSelectedChats').onclick=()=>generateChatExport(false);
$('shareExportChats').onclick=()=>generateChatExport(true);
$('autoChatExport').onchange=async()=>{
 const el=$('autoChatExport');el.disabled=true;
 try{const d=await api('/conversations/export/automatic','POST',{enabled:el.checked});
   $('chatExportResult').textContent=d.enabled?'Lokale automatische Exportkopie aktiviert (keine Cloud-Übertragung).':'Lokale Exportkopie wird nicht mehr automatisch aktualisiert.';
 }catch(e){el.checked=!el.checked;$('chatExportResult').textContent=e.message;}
 finally{el.disabled=false;setTimeout(refreshChatExportOptions,3200);}
};
$('downloadChatSnapshot').onclick=async()=>{
 try{
  const r=await fetch('/api/v1/conversations/export/latest',{headers:authHeaders(),cache:'no-store'});
  if(!r.ok){const e=await r.json().catch(()=>({}));throw Error(e.error||'HTTP '+r.status);}
  triggerFileDownload(await r.blob(),'bmw-ai-chat-snapshot.md');
  $('chatExportResult').textContent='Lokalen Chat-Snapshot heruntergeladen.';
 }catch(e){$('chatExportResult').textContent='Snapshot: '+e.message;}
};

// ----- Browser-initiated, separately signed Raspberry Pi updates -----
async function refreshUpdates(){
  if(!token)return;
  const check=$('autoUpdate'),label=$('autoUpdateInfo');
  check.disabled=true;
  label.textContent='Gespeicherte Auto-Update-Einstellung wird geladen ...';
  try{
    const d=await api('/updates');
    $('updateStatus').textContent=JSON.stringify(d,null,2);
    if(d.autoSettingsError){
      label.textContent='Einstellung konnte nicht gelesen werden. Bitte Dateirechte auf dem Pi prüfen.';
      return;
    }
    check.checked=d.auto===true;
    check.disabled=false;
    label.textContent=d.auto===true
      ?'Automatische Updates sind auf dem Pi gespeichert und aktiviert.'
      :'Automatische Updates sind auf dem Pi gespeichert und deaktiviert.';
    const a=d.autoCheck;
    if(d.auto===true&&a&&a.lastAt)label.textContent+=' Letzte Prüfung '+stamp(a.lastAt)+': '+(a.message||a.result)+(a.nextAt?' Nächste '+stamp(a.nextAt)+'.':'');
    else if(d.auto===true)label.textContent+=' Erste Prüfung etwa 2 Minuten nach dem Start des Pi-Servers.';
  }catch(e){
    label.textContent='Automatische Updates: Zustand konnte nicht geladen werden ('+e.message+').';
    $('updateStatus').textContent='Updater: '+e.message;
    // Keep the control disabled. An API failure is not proof that auto updates are off.
  }
}
$('refreshUpdates').onclick=async()=>{
 const btn=$('refreshUpdates');btn.disabled=true;
 $('updateCheckResult').textContent='GitHub wird jetzt geprüft ...';
 try{const result=await api('/updates/check','POST');
   $('updateCheckResult').textContent=result.message||JSON.stringify(result,null,2);
   await refreshUpdates();
   if(result.state==='queued')setTimeout(refreshUpdates,7000);
 }catch(e){$('updateCheckResult').textContent='Updateprüfung fehlgeschlagen: '+e.message;}
 finally{btn.disabled=false;}
};
$('uploadUpdate').onclick=async()=>{
  const file=$('updateZip').files[0];if(!file)return notice('Bitte ein Update-ZIP auswählen.');
  if(file.size>3*1024*1024)return notice('Update-ZIP darf maximal 3 MiB groß sein.');
  const btn=$('uploadUpdate');btn.disabled=true;
  try{const response=await fetch('/api/v1/updates/upload',{method:'POST',headers:authHeaders(),body:file});
    const data=await response.json();if(!response.ok)throw Error(data.error||'Upload fehlgeschlagen');
    pendingUpdate=data;$('updateDetails').textContent=file.name+'\nGröße: '+data.bytes+' Bytes\nSHA-256: '+data.sha256+'\nNur nach Signaturprüfung installierbar.';
    $('updateConfirm').hidden=false;notice('ZIP hochgeladen, noch nicht installiert.');
  }catch(e){notice('Update-Upload: '+e.message);}finally{btn.disabled=false;}
};
$('confirmUpdate').onclick=async()=>{
 if(!pendingUpdate)return;
 const b=$('confirmUpdate');b.disabled=true;
 try{const d=await api('/updates/confirm','POST',{id:pendingUpdate.id,sha256:pendingUpdate.sha256});
   notice('Update zur Signaturprüfung und Installation vorgemerkt. Status danach aktualisieren.');
   pendingUpdate=null;$('updateConfirm').hidden=true;setTimeout(refreshUpdates,2200);
 }catch(e){notice('Update: '+e.message);}finally{b.disabled=false;}
};
$('cancelUpdate').onclick=()=>{pendingUpdate=null;$('updateConfirm').hidden=true;notice('Update nicht beauftragt.');};
$('autoUpdate').onchange=async()=>{
 const el=$('autoUpdate'),desired=el.checked;
 el.disabled=true;
 $('autoUpdateInfo').textContent='Einstellung wird dauerhaft auf dem Pi gespeichert ...';
 try{
   const r=await api('/updates/automatic','POST',{enabled:desired});
   $('autoUpdateInfo').textContent=r.auto?'Automatische Updates dauerhaft aktiviert.':'Automatische Updates dauerhaft deaktiviert.';
   notice(r.auto?'Automatische signierte Updates aktiviert.':'Automatische Updates deaktiviert.');
 }catch(e){
   notice('Automatische Updates: '+e.message);
   $('autoUpdateInfo').textContent='Speichern fehlgeschlagen. Der bisherige Zustand wird erneut abgefragt.';
 }
 await refreshUpdates();
};

// ----- System: Serverprotokoll -----
async function refreshLogs(){
 try{
  const logs=(await api('/logs')).logs;
  $('logsResult').textContent=logs.length?logs.map(l=>new Date(l.at).toLocaleString('de-DE')+'  '+l.action+(l.details?'  '+l.details:'')).join('\n'):'Noch keine Einträge.';
 }catch(e){notice(e.message);}
}
$('refreshLogs').onclick=refreshLogs;
$('downloadLogs').onclick=()=>authenticatedDownload('/logs/download','bmw-ai-logs.json');
function vehicleState(v){
 const states={running:'Vehicle Data aktiv',stale:'Vehicle Data · Heartbeat veraltet',
  not_detected:'Vehicle Data nicht gefunden',no_snapshot:'Vehicle Data installiert · Snapshot fehlt',
  snapshot_error:'Vehicle Data · Snapshot fehlerhaft',storage_unavailable:'OAP-Speicher nicht erreichbar',unknown:'Vehicle Data · Startstatus unbekannt'};
 return [states[v.appState]||'Vehicle Data · Status unbekannt',v.reason||'',(v.status||v.vehicle)==='waiting'?'Wartet auf Fahrzeugwerte':''].filter(Boolean).join(' · ');
}
let connectionEntries=[];
async function refreshConnection(probe=false){
 try{
  if(probe)await api('/monitor/poll','POST');
  const d=await api('/connection'),p=d.poll||{},ecu=p.signals&&p.signals.Diagnostics;
  $('connectionStatus').textContent=[
   'Raspberry Pi online · Web-API erreichbar',
   'MGU-Agent '+({reachable:'erreichbar',unreachable:'nicht erreichbar',unknown:'ungeprüft'}[d.agent])+(p.error?' · '+p.error:''),
   'SSH '+({unknown:'ungeprüft',authenticated:'authentifiziert',error:'Verbindungs- oder Anmeldefehler',timeout:'Zeitüberschreitung',not_configured:'nicht konfiguriert'}[d.ssh.state]||d.ssh.state),
   vehicleState(p),
   'Letzter Snapshot mit Fahrzeugwerten · '+(stamp(p.lastData)||'unbekannt'),
   'Diagnose · '+(d.diagnosis.running?'läuft':ecu?(ecu.available?'bereit':ecu.error||'nicht verfügbar'):'ungeprüft'),
   'Letzter erfolgreicher Fehlerscan · '+(stamp(d.diagnosis.lastSuccess)||'unbekannt')
  ].join('\n');
  if($('connectionLogPanel').open)await refreshConnectionLog();
 }catch(e){$('connectionStatus').textContent='Web-API nicht erreichbar · '+e.message;}
}
function logText(){
 return connectionEntries.map(e=>[e.at,e.component,e.endpoint,e.status||'–',e.outcome].join(' · ')).join('\n');
}
async function refreshConnectionLog(method='GET'){
 try{
  connectionEntries=(await api('/connection/log',method)).entries;
  const out=$('connectionLog');out.textContent=logText();
  if($('connectionLogScroll').checked)out.scrollTop=out.scrollHeight;
 }catch(e){notice(e.message);}
}
$('connectionRefresh').onclick=()=>refreshConnection(true);
$('sshProbe').onclick=async()=>{
 $('sshProbe').disabled=true;
 try{await api('/connection/ssh','POST');await refreshConnection();}
 catch(e){notice(e.message);}finally{$('sshProbe').disabled=false;}
};
$('connectionLogPanel').ontoggle=()=>{if($('connectionLogPanel').open)refreshConnectionLog();};
$('connectionLogClear').onclick=()=>refreshConnectionLog('DELETE');
$('connectionLogCopy').onclick=()=>navigator.clipboard.writeText(logText()).catch(e=>notice(e.message));
$('connectionLogText').onclick=()=>triggerFileDownload(new Blob([logText()],{type:'text/plain'}),'bmw-ai-verbindungen.txt');
$('connectionLogJson').onclick=()=>triggerFileDownload(new Blob([JSON.stringify(connectionEntries,null,2)],{type:'application/json'}),'bmw-ai-verbindungen.json');
setInterval(()=>{if(token&&currentTab==='system')refreshConnection();},5000);
function showGithubDiagnostics(state){
 const error=state.lastError;
 const messages={
  repository_not_private:'GitHub bestätigt kein privates Ziel-Repository.',
  unexpected_github_file:'GitHub hat einen unerwarteten Dateityp gemeldet.',
  network_or_storage:'Die Verbindung oder das Speichern auf dem Pi ist fehlgeschlagen.'
 };
 const parts=[state.enabled?'Automatik aktiv':'Automatik aus',state.sending?'Übertragung läuft':null,
  state.lastSuccessAt?'Letzter bestätigter Bericht '+stamp(state.lastSuccessAt):null,
  error?(messages[error]||'GitHub antwortet mit HTTP '+error.split('_').pop()+'.'):null];
 $('githubDiagnosticsStatus').textContent=parts.filter(Boolean).join(' · ');
}
async function refreshGithubDiagnostics(loadForm=false){
 try{
  const state=await api('/github-diagnostics');
  if(loadForm){
   $('githubDiagnosticsRepo').value=state.repo;
   $('githubDiagnosticsEnabled').checked=state.enabled;
   $('githubDiagnosticsToken').placeholder=state.hasToken?'Auf dem Pi gespeichert':'Token eingeben';
   $('githubDiagnosticsSave').disabled=false;
  }
  showGithubDiagnostics(state);
 }catch(e){$('githubDiagnosticsStatus').textContent=e.message;}
}
$('githubDiagnosticsPanel').ontoggle=()=>{
 if($('githubDiagnosticsPanel').open)refreshGithubDiagnostics(true);
};
$('githubDiagnosticsForm').onsubmit=async e=>{
 e.preventDefault();
 const button=$('githubDiagnosticsSave'),secret=$('githubDiagnosticsToken');
 button.disabled=true;
 try{
  const state=await api('/github-diagnostics','POST',{repo:$('githubDiagnosticsRepo').value.trim(),
   token:secret.value.trim(),enabled:$('githubDiagnosticsEnabled').checked});
  secret.value='';
  secret.placeholder=state.hasToken?'Auf dem Pi gespeichert':'Token eingeben';
  showGithubDiagnostics(state);
 }catch(err){$('githubDiagnosticsStatus').textContent=err.message;}
 finally{button.disabled=false;}
};
setInterval(()=>{
 if(token&&currentTab==='system'&&$('githubDiagnosticsPanel').open)refreshGithubDiagnostics();
},10000);
let serviceReferences=null;
function showServiceReference(){
 if(!serviceReferences)return;
 const data=serviceReferences;
 const status=$('serviceReferenceStatus');
 status.textContent=[data.version?'Datenbank '+data.version:'Datenbank nicht geladen',
  data.fallbackActive?'Mitgelieferte ServiceHistory-Referenz aktiv':null,
  data.total+' Referenzeinträge',data.confirmed+' bestätigt',data.external+' extern dokumentiert',data.unknown+' unbekannt',data.ambiguous+' mehrdeutig',
  data.updatedAt?'Aktualisiert '+stamp(data.updatedAt):null,data.error].filter(Boolean).join(' · ');
 const query=$('serviceReferenceSearch').value.trim().toLowerCase(),filter=$('serviceReferenceFilter').value;
 const hex=id=>'0x'+id.toString(16).toUpperCase().padStart(2,'0');
 const rowGroup=row=>[row.namespace,row.code,row.vehicle||'',row.variant||''].join(':');
 const ambiguous=new Set(data.ambiguousKeys||[]);
 const refs=data.rows.map(row=>({...row,status:ambiguous.has(rowGroup(row))?'ambiguous':row.verification}));
 const observed=data.observations.filter(row=>['unknown','ambiguous','reserved'].includes(row.status));
 const rows=[...observed,...refs].filter(r=>(!filter||r.status===filter)&&
  [r.namespace,r.code,hex(r.code),r.original,r.de,r.en,r.variant,r.source].some(value=>String(value??'').toLowerCase().includes(query)));
 const labels={unknown:'Unbekannt',verified:'Bestätigt',external:'Extern dokumentiert',reserved:'Reserviert',ambiguous:'Mehrdeutig',unverified:'Ungeprüft'};
 const box=$('serviceReferenceRows');
 box.replaceChildren(...rows.slice(0,80).map(r=>{
  const node=txt('div','','service-entry');
  node.append(txt('strong',r.code+' · '+hex(r.code)+' · '+(r.de||r.original||labels[r.status])),
   txt('p',[r.namespace,r.variant,r.source,labels[r.status],r.count?r.count+' Abfragen':null].filter(Boolean).join(' · '),'hint'));
  return node;
 }));
 if(!rows.length)box.append(txt('p','Keine passenden Einträge.','hint'));
 if(rows.length>80)box.append(txt('p','80 von '+rows.length+' Treffern. Suche oder Filter eingrenzen.','hint'));
}
$('serviceReferencePanel').ontoggle=async()=>{
 if(!$('serviceReferencePanel').open)return;
 try{serviceReferences=await api('/service-reference');showServiceReference();}
 catch(e){$('serviceReferenceStatus').textContent=e.message;}
};
$('serviceReferenceSearch').oninput=showServiceReference;
$('serviceReferenceFilter').onchange=showServiceReference;
$('serviceReferenceExport').onclick=async()=>{
 try{
  serviceReferences=await api('/service-reference');
  const observations=serviceReferences.observations.filter(row=>row.status==='unknown'||row.status==='ambiguous');
  triggerFileDownload(new Blob([JSON.stringify({schema:1,observations},null,2)],{type:'application/json'}),'bmw-servicecodes-unbekannt.json');
  showServiceReference();
 }catch(e){notice(e.message);}
};
$('serviceReferenceForm').onsubmit=async e=>{
 e.preventDefault();
 const file=$('serviceReferenceFile').files[0];
 if(!file||file.size>2*1024*1024){notice('Bitte eine JSON-Datei bis 2 MiB auswählen.');return;}
 try{
  serviceReferences=await api('/service-reference','POST',JSON.parse(await file.text()));
  $('serviceReferenceFile').value='';
  showServiceReference();notice('Referenzdaten aktualisiert.');
 }catch(err){notice(err.message);}
};

function refreshSystem(){refreshUpdates();$('referenceCheck').click();refreshLogs();refreshNotify();refreshConnection();}

// ----- Automatically refresh this already-open webpage after a successful Pi update -----
// The server embeds its running version into HTML on each page load. Re-check via
// uncached /health, so an updater restart or a temporary network outage cannot
// trick the UI into an infinite reload loop.
const BMAI_PAGE_VERSION=document.querySelector('meta[name="bmw-ai-version"]')?.content||'';
const BMAI_AUTO_RELOADED_KEY='bmw-ai-last-auto-reload-version';
let bmaiVersionCheckBusy=false,bmaiPendingVersion='';
function bmaiHasUnsavedWork(){
  const textIds=['chatInput','consoleInput','password'];
  if(textIds.some(id=>{const e=$(id);return e&&typeof e.value==='string'&&e.value.trim().length>0;}))return true;
  for(const id of ['chatExport','updateZip']){
    const e=$(id);if(e&&e.files&&e.files.length)return true;
  }
  if($('sendChat')?.disabled||$('loginButton')?.disabled||$('uploadUpdate')?.disabled)return true;
  if(typeof consoleRunning!=='undefined'&&consoleRunning)return true;
  if(typeof pendingUpdate!=='undefined'&&pendingUpdate)return true;
  if($('updateConfirm')&&!$('updateConfirm').hidden)return true;
  if($('chatImportPanel')&&!$('chatImportPanel').hidden)return true;
  if($('chatExportPanel')&&!$('chatExportPanel').hidden)return true;
  return false;
}
function bmaiShowReloadPrompt(){
  const panel=$('newVersionNotice'),message=$('newVersionMessage');
  if(!panel||!message)return;
  panel.hidden=false;
  message.textContent='BMW AI '+bmaiPendingVersion+' installiert. Neue Webseite verfügbar.';
}
function bmaiCaptureView(){
  sessionStorage.setItem('bmw-ai-resume-tab',currentTab);
  if(conversationId)sessionStorage.setItem('bmw-ai-resume-conversation',conversationId);
  else sessionStorage.removeItem('bmw-ai-resume-conversation');
}
function bmaiReloadIfSafe(){
  if(!bmaiPendingVersion)return;
  if(sessionStorage.getItem(BMAI_AUTO_RELOADED_KEY)===bmaiPendingVersion){
    bmaiShowReloadPrompt();return;
  }
  if(bmaiHasUnsavedWork()){bmaiShowReloadPrompt();return;}
  bmaiCaptureView();
  sessionStorage.setItem(BMAI_AUTO_RELOADED_KEY,bmaiPendingVersion);
  const url=new URL(window.location.href);
  url.searchParams.set('uiVersion',bmaiPendingVersion);
  window.location.replace(url.href);
}
async function bmaiCheckServerBuild(){
  if(bmaiVersionCheckBusy||!BMAI_PAGE_VERSION)return;
  bmaiVersionCheckBusy=true;
  try{
    const r=await fetch('/health',{method:'GET',cache:'no-store',credentials:'same-origin',headers:{'cache-control':'no-cache'}});
    if(!r.ok)return;
    const d=await r.json();
    if(d.ok!==true||typeof d.version!=='string'||! /^\d+\.\d+\.\d+$/.test(d.version))return;
    if(d.version===BMAI_PAGE_VERSION){
      bmaiPendingVersion='';
      sessionStorage.removeItem(BMAI_AUTO_RELOADED_KEY);
      const panel=$('newVersionNotice');if(panel)panel.hidden=true;
      return;
    }
    bmaiPendingVersion=d.version;
    bmaiReloadIfSafe();
  }catch(e){
    // A restart can briefly make /health unreachable: do nothing until it returns.
  }finally{bmaiVersionCheckBusy=false;}
}
$('reloadNewVersion').onclick=()=>{
  if(!bmaiPendingVersion)return;
  if(bmaiHasUnsavedWork()&&!window.confirm('Es gibt noch ungespeicherte Eingaben. Jetzt trotzdem neu laden?'))return;
  bmaiCaptureView();
  sessionStorage.setItem(BMAI_AUTO_RELOADED_KEY,bmaiPendingVersion);
  const url=new URL(window.location.href);url.searchParams.set('uiVersion',bmaiPendingVersion);
  window.location.replace(url.href);
};
setInterval(bmaiCheckServerBuild,15000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)bmaiCheckServerBuild();});
window.addEventListener('pageshow',()=>bmaiCheckServerBuild());
document.addEventListener('input',()=>{if(bmaiPendingVersion)setTimeout(bmaiReloadIfSafe,500);});
document.addEventListener('change',()=>{if(bmaiPendingVersion)setTimeout(bmaiReloadIfSafe,500);});
bmaiCheckServerBuild();

// ----- Start -----
restoreSession();
renderPair();


// ----- Statistiken: Fahrtenbuch und Diagramme aus der Fahrzeugtelemetrie -----
// Nur echte Messwerte. Fehlende Werte erscheinen als „–“, nie als 0. Diagramme sind eigenes SVG
// (keine externe Bibliothek, CSP style-src 'self': Formen über SVG-Attribute, Breiten über CSSOM).
let statsTrips=[],statsTripId=null,statsView=null,statsRange='7',statsOverview=null;
const chartRenders=new Map();
const dash='–',SVGNS='http://www.w3.org/2000/svg';
const COLOR={blue:'#3b7cf4',green:'#4fb35a',yellow:'#f0c64a',orange:'#ec8a4b'};
const fmtNum=(v,d=0)=>v===null||v===undefined||!Number.isFinite(v)?dash:v.toLocaleString('de-DE',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtKm=v=>v===null||v===undefined?dash:fmtNum(v,v<100?1:0)+' km';
const fmtDur=ms=>{if(ms===null||ms===undefined)return dash;const m=Math.round(ms/60000);return m<60?m+' min':Math.floor(m/60)+' h '+String(m%60).padStart(2,'0')+' min';};
const fmtDay=ts=>new Date(ts).toLocaleDateString('de-DE',{weekday:'short',day:'2-digit',month:'2-digit',year:'numeric'});
const fmtTime=ts=>new Date(ts).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
const weekday=ts=>new Date(ts).toLocaleDateString('de-DE',{weekday:'short'}).replace('.','');
const DIST_SOURCE={odometer:'Kilometerstand',speed:'Geschwindigkeit integriert',speed_incomplete:'Geschwindigkeit, lückenhaft'};
const QUALITY={good:'vollständig',partial:'teilweise',poor:'lückenhaft'};
function svgEl(tag,attrs,parent){const e=document.createElementNS(SVGNS,tag);for(const k in attrs)e.setAttribute(k,attrs[k]);if(parent)parent.appendChild(e);return e;}
function statBox(parent,label,value){const c=txt('div','','stat');c.appendChild(txt('span',label,'hint'));c.appendChild(txt('strong',value));parent.appendChild(c);}
function tripLabel(t){return t.name||(fmtDay(t.start_ts)+' · '+fmtTime(t.start_ts)+(t.end_ts?'–'+fmtTime(t.end_ts):' · läuft'));}

/** Smooth line through points without overshoot (monotone cubic, Fritsch-Carlson). */
function smoothPath(pts){
  const n=pts.length;if(!n)return '';
  if(n===1)return 'M'+pts[0][0]+' '+pts[0][1]+'h0.5';
  const dx=[],dy=[],m=[],t=[];
  for(let i=0;i<n-1;i++){dx[i]=pts[i+1][0]-pts[i][0];dy[i]=pts[i+1][1]-pts[i][1];m[i]=dx[i]?dy[i]/dx[i]:0;}
  t[0]=m[0];t[n-1]=m[n-2];
  for(let i=1;i<n-1;i++)t[i]=m[i-1]*m[i]<=0?0:(m[i-1]+m[i])/2;
  for(let i=0;i<n-1;i++){
    if(m[i]===0){t[i]=0;t[i+1]=0;continue;}
    const a=t[i]/m[i],b=t[i+1]/m[i],h=a*a+b*b;
    if(h>9){const k=3/Math.sqrt(h);t[i]=k*a*m[i];t[i+1]=k*b*m[i];}
  }
  let d='M'+pts[0][0].toFixed(1)+' '+pts[0][1].toFixed(1);
  for(let i=0;i<n-1;i++){
    const h=dx[i]/3;
    d+='C'+(pts[i][0]+h).toFixed(1)+' '+(pts[i][1]+t[i]*h).toFixed(1)+' '+(pts[i+1][0]-h).toFixed(1)+' '+(pts[i+1][1]-t[i+1]*h).toFixed(1)+' '+pts[i+1][0].toFixed(1)+' '+pts[i+1][1].toFixed(1);
  }
  return d;
}

/**
 * Line chart in the style of the statistics page: legend with the value under the finger,
 * dashed grid, y labels left, three x labels, cursor line with dots and a label on top.
 * opt.series: [{name,color,unit,digits,points:[[x,y]...]}] (series without points show "–").
 */
function lineChart(host,opt){
  const draw=()=>{
    host.replaceChildren();
    const legend=txt('div','','chart-legend');host.appendChild(legend);
    const legs=opt.series.map(s=>{
      const leg=txt('div','','leg'+(s.points.length?'':' off'));const bar=document.createElement('i');bar.style.background=s.color;leg.appendChild(bar);
      const box=document.createElement('div');box.appendChild(txt('span',s.name));const val=txt('strong',dash);box.appendChild(val);leg.appendChild(box);legend.appendChild(leg);
      return val;
    });
    const W=Math.max(280,Math.round(host.clientWidth||340)),H=opt.height||300,pad={l:opt.yTitle?80:62,r:12,t:34,b:30};
    const svg=svgEl('svg',{viewBox:'0 0 '+W+' '+H,class:'chart-svg',role:'img','aria-label':opt.label||''},host);
    const iw=W-pad.l-pad.r,ih=H-pad.t-pad.b;
    const X=x=>pad.l+(opt.xMax===opt.xMin?iw:(x-opt.xMin)/(opt.xMax-opt.xMin)*iw);
    const Y=y=>pad.t+ih-(y-opt.yMin)/(opt.yMax-opt.yMin)*ih;
    const hasData=opt.series.some(s=>s.points.length);
    for(const tick of opt.yTicks){
      svgEl('line',{x1:pad.l,x2:W-pad.r,y1:Y(tick),y2:Y(tick),class:'grid'},svg);
      if(hasData)svgEl('text',{x:pad.l-10,y:Y(tick)+4,'text-anchor':'end'},svg).textContent=opt.yFmt(tick);
    }
    if(opt.yTitle&&hasData){const t=svgEl('text',{x:18,y:pad.t+ih/2,'text-anchor':'middle',transform:'rotate(-90 18 '+(pad.t+ih/2)+')'},svg);t.textContent=opt.yTitle;}
    const [xl,xm,xr]=opt.xLabels;
    svgEl('text',{x:pad.l,y:H-8,'text-anchor':'start'},svg).textContent=xl;
    svgEl('text',{x:pad.l+iw/2,y:H-8,'text-anchor':'middle'},svg).textContent=xm;
    svgEl('text',{x:W-pad.r,y:H-8,'text-anchor':'end'},svg).textContent=xr;
    if(!hasData){const e=txt('div',opt.empty||'Noch keine Messwerte.','chart-empty');host.appendChild(e);return;}
    for(const s of opt.series){
      // Separate segments at gaps: missing data stays a gap, never a straight line across.
      let seg=[];
      const flush=()=>{if(seg.length)svgEl('path',{d:smoothPath(seg),fill:'none',stroke:s.color,'stroke-width':2.4,'stroke-linejoin':'round','stroke-linecap':'round'},svg);seg=[];};
      s.points.forEach((p,i)=>{if(i&&p[0]-s.points[i-1][0]>opt.gapX)flush();seg.push([X(p[0]),Y(Math.max(opt.yMin,Math.min(opt.yMax,p[1])))]);});
      flush();
    }
    const cursor=svgEl('g',{},svg);
    const line=svgEl('line',{y1:pad.t,y2:pad.t+ih,class:'cursor'},cursor);
    const label=svgEl('text',{y:pad.t-14,class:'cursor-label'},cursor);
    const dots=opt.series.map(s=>svgEl('circle',{r:6,fill:s.color,stroke:'#1b1d22','stroke-width':2},cursor));
    const nearest=(pts,x)=>{let lo=0,hi=pts.length-1;if(hi<0)return null;while(lo<hi){const mid=(lo+hi)>>1;if(pts[mid][0]<x)lo=mid+1;else hi=mid;}
      const c=[pts[lo],pts[lo-1]].filter(Boolean).sort((a,b)=>Math.abs(a[0]-x)-Math.abs(b[0]-x))[0];return Math.abs(c[0]-x)<=opt.gapX?c:null;};
    const place=x=>{
      x=Math.max(opt.xMin,Math.min(opt.xMax,x));const px=X(x);
      line.setAttribute('x1',px);line.setAttribute('x2',px);
      label.textContent=opt.cursorFmt(x);
      label.setAttribute('x',px);label.setAttribute('text-anchor',px>W-60?'end':px<pad.l+40?'start':'middle');
      opt.series.forEach((s,i)=>{
        const p=nearest(s.points,x);
        dots[i].setAttribute('visibility',p?'visible':'hidden');
        if(p){dots[i].setAttribute('cx',px);dots[i].setAttribute('cy',Y(Math.max(opt.yMin,Math.min(opt.yMax,p[1]))));}
        legs[i].textContent=p?fmtNum(p[1],s.digits||0)+' '+s.unit:dash;
      });
    };
    const lastX=Math.max(...opt.series.filter(s=>s.points.length).map(s=>s.points[s.points.length-1][0]));
    place(lastX);
    const toX=e=>{const r=svg.getBoundingClientRect();const px=(e.clientX-r.left)*W/r.width;return opt.xMin+(px-pad.l)/iw*(opt.xMax-opt.xMin);};
    svg.addEventListener('pointerdown',e=>place(toX(e)));
    svg.addEventListener('pointermove',e=>{if(e.pointerType==='mouse'||e.buttons)place(toX(e));});
    svg.addEventListener('pointerleave',e=>{if(e.pointerType==='mouse')place(lastX);});
  };
  chartRenders.set(host,draw);
  draw();
  if(opt.maxRow){
    const row=txt('div','','chart-max');
    opt.maxRow.forEach(([l,v])=>{const c=document.createElement('div');c.appendChild(txt('span',l));c.appendChild(txt('strong',v));row.appendChild(c);});
    host.appendChild(row);
    const redraw=draw;chartRenders.set(host,()=>{redraw();host.appendChild(row);});
  }
}
let resizeTimer=null;
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>chartRenders.forEach((f,host)=>{if(host.isConnected&&host.offsetParent)f();}),150);});

function barList(host,rows,unitFmt){
  host.replaceChildren();
  const max=Math.max(1,...rows.map(r=>r.value||0));
  if(!rows.length){host.appendChild(txt('p','Keine Fahrten in diesem Zeitraum.','stats-caption'));return;}
  for(const r of rows){
    const row=txt('div','','bar-row'),head=txt('div','','bar-head');
    head.appendChild(txt('span',r.label));head.appendChild(txt('span',unitFmt(r.value)));
    const track=txt('div','','bar-track'),fill=txt('div','','bar-fill');
    fill.style.width=Math.max(0,Math.min(100,(r.value||0)/max*100))+'%';
    track.appendChild(fill);row.appendChild(head);row.appendChild(track);host.appendChild(row);
  }
}
const ICONS={
  route:'<circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="6" r="2.4"/><path d="M8.4 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.6"/>',
  fuel:'<path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M4 10h10"/><path d="M14 8.5l3 3v6a1.5 1.5 0 0 0 3 0V9.5L17 6.5"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  gauge:'<path d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path d="M12 13l4-4"/><circle cx="12" cy="13.5" r="1.2"/>'
};
function kpi(host,icon,label,value,unit){
  const c=txt('div','','kpi');
  const svg=svgEl('svg',{viewBox:'0 0 24 24','aria-hidden':'true'});
  // Static, trusted markup of the four icons above.
  svg.innerHTML=ICONS[icon];c.appendChild(svg);
  c.appendChild(txt('span',label,'kpi-label'));c.appendChild(txt('span',value,'kpi-value'));
  if(unit)c.appendChild(txt('span',unit,'kpi-unit'));
  host.appendChild(c);
}
function rangeBounds(range){
  const now=Date.now(),d=new Date();d.setHours(0,0,0,0);
  if(range==='today')return [d.getTime(),now];
  if(range==='7'){d.setDate(d.getDate()-6);return [d.getTime(),now];}
  if(range==='30'){d.setDate(d.getDate()-29);return [d.getTime(),now];}
  return [0,now];
}
function isoWeek(ts){const d=new Date(ts);d.setHours(0,0,0,0);d.setDate(d.getDate()+3-(d.getDay()+6)%7);const w1=new Date(d.getFullYear(),0,4);
  return 1+Math.round(((d-w1)/86400000-3+(w1.getDay()+6)%7)/7);}
function distanceRows(trips,range,[from]){
  const km=t=>t.distanceKm||0;
  if(range==='today')return [trips.map(t=>({label:fmtTime(t.start)+(t.name?' · '+t.name:''),value:km(t)})),'Heute, je Fahrt'];
  if(range==='7'){
    const rows=[];for(let i=0;i<7;i++){const d=new Date(from);d.setDate(d.getDate()+i);const a=d.getTime();d.setDate(d.getDate()+1);const b=d.getTime();
      rows.push({label:weekday(a),value:trips.filter(t=>t.start>=a&&t.start<b).reduce((s,t)=>s+km(t),0)});}
    return [rows,'Letzte sieben Tage'];
  }
  if(range==='30'){
    const rows=new Map();for(let i=0;i<30;i++){const d=new Date(from);d.setDate(d.getDate()+i);const key='KW '+isoWeek(d.getTime());if(!rows.has(key))rows.set(key,0);}
    trips.forEach(t=>{const key='KW '+isoWeek(t.start);rows.set(key,(rows.get(key)||0)+km(t));});
    return [[...rows].map(([label,value])=>({label,value})),'Letzte 30 Tage, je Kalenderwoche'];
  }
  const rows=new Map();
  trips.forEach(t=>{const key=new Date(t.start).toLocaleDateString('de-DE',{month:'short',year:'numeric'});rows.set(key,(rows.get(key)||0)+km(t));});
  return [[...rows].slice(-12).map(([label,value])=>({label,value})),'Gesamter Zeitraum, je Monat'];
}
function renderOverview(){
  const o=statsOverview;if(!o)return;
  const trips=o.trips,closed=trips;
  const k=$('statsKpis');k.replaceChildren();
  const dist=closed.reduce((s,t)=>s+(t.distanceKm||0),0),time=closed.reduce((s,t)=>s+(t.durationMs||0),0);
  const vmax=closed.reduce((m,t)=>t.maxSpeedKmh!=null&&t.maxSpeedKmh>m?t.maxSpeedKmh:m,-1);
  kpi(k,'route','Fahrstrecke',closed.length?fmtKm(dist):dash);
  kpi(k,'fuel','Ø Verbrauch',dash,'l/100 km');
  kpi(k,'clock','Fahrzeit',closed.length?fmtDur(time):dash);
  kpi(k,'gauge','Höchstgeschwindigkeit',vmax>=0?fmtNum(vmax)+' km/h':dash);
  const [rows,caption]=distanceRows(trips,statsRange,rangeBounds(statsRange));
  barList($('statsDistance'),rows,v=>fmtNum(v,v>0&&v<10?1:0)+' km');
  $('statsDistanceCaption').textContent=caption;
  // Consumption: the chart appears once the tank level unit is confirmed. No invented values.
  const [from,to]=rangeBounds(statsRange);
  lineChart($('statsFuel'),{series:[{name:'Verbrauch',color:COLOR.blue,unit:'l/100 km',digits:1,points:[]}],xMin:from,xMax:to,yMin:0,yMax:10,yTicks:[0,2.5,5,7.5,10],
    yFmt:v=>fmtNum(v,v%1?2:0)+' l/100 km',yTitle:'Verbrauch',xLabels:statsRange==='today'?['0 Uhr','Uhrzeit','jetzt']:statsRange==='7'?[weekday(from),'Tag',weekday(to)]:
      statsRange==='30'?[new Date(from).toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'}),'Tag','heute']:['','Monat',''],cursorFmt:()=>'',gapX:1,height:260,
    empty:'Noch keine Verbrauchswerte'});
  const bands=[0,0,0,0,0];closed.forEach(t=>(t.speedBandsMs||[]).forEach((v,i)=>{bands[i]+=v;}));
  const names=['0–30 km/h','30–60 km/h','60–100 km/h','100–130 km/h','über 130 km/h'];
  const total=bands.reduce((a,b)=>a+b,0);
  barList($('statsBands'),total?bands.map((v,i)=>({label:names[i],value:v})):[],v=>fmtDur(v)+(total?' · '+fmtNum(v/total*100)+' %':''));
}
async function warmupChart(host,trip,captionEl){
  if(!trip){host.replaceChildren(txt('p','Noch keine Fahrt aufgezeichnet.','stats-caption'));return;}
  const id=trip.id,start=trip.start_ts??trip.start,end=trip.end_ts??trip.end??Date.now();
  if(captionEl)captionEl.textContent=(trip.name||fmtDay(start)+' '+fmtTime(start))+' · Temperaturen in °C';
  const d=await api('/telemetry/trips/'+id+'/series?signals=coolant,oil&max=900');
  const toPts=k=>(d.series[k]?.points||[]).map(p=>[(p[0]+p[1]/2-start)/60000,p[2]]);
  const coolant=toPts('coolant'),oil=toPts('oil');
  const top=Math.max(120,...coolant.map(p=>p[1]),...oil.map(p=>p[1]));
  const yMax=Math.ceil(top/30)*30,durMin=Math.max(1,(end-start)/60000);
  const maxOf=k=>{const v=(d.series[k]?.points||[]).map(p=>p[4]);return v.length?fmtNum(Math.max(...v))+' °C':dash;};
  lineChart(host,{series:[
      {name:'Kühlmittel',color:COLOR.blue,unit:'°C',points:coolant},
      {name:'Motoröl',color:COLOR.green,unit:'°C',points:oil},
      {name:'Getriebeöl',color:COLOR.yellow,unit:'°C',points:[]}],
    xMin:0,xMax:durMin,yMin:0,yMax,yTicks:Array.from({length:yMax/30+1},(_,i)=>i*30),yFmt:v=>v+' °C',
    xLabels:['0 min','Minute',fmtNum(durMin)+' min'],cursorFmt:x=>fmtNum(x)+' min',gapX:3,label:'Warmlaufverlauf',
    maxRow:[['Max. Motoröl',maxOf('oil')],['Max. Kühlmittel',maxOf('coolant')],['Max. Getriebeöl',dash]],
    empty:'Für diese Fahrt liegen keine Temperaturwerte vor.'});
}
async function tripLineCharts(t){
  const start=t.start_ts,end=t.end_ts||Date.now(),durMin=Math.max(1,(end-start)/60000);
  const d=await api('/telemetry/trips/'+t.id+'/series?signals=speed,rpm&max=1200');
  const pts=k=>(d.series[k]?.points||[]).map(p=>[(p[0]+p[1]/2-start)/60000,p[2]]);
  const speed=pts('speed'),rpm=pts('rpm');
  const vTop=Math.max(60,Math.ceil(Math.max(0,...speed.map(p=>p[1]))/30)*30);
  lineChart($('statsTripSpeed'),{series:[{name:'Geschwindigkeit',color:COLOR.blue,unit:'km/h',points:speed}],xMin:0,xMax:durMin,yMin:0,yMax:vTop,
    yTicks:Array.from({length:vTop/30+1},(_,i)=>i*30),yFmt:v=>v+' km/h',xLabels:['0 min','Minute',fmtNum(durMin)+' min'],cursorFmt:x=>fmtNum(x)+' min',gapX:1,height:240,
    empty:'Keine Geschwindigkeitswerte.'});
  const rTop=Math.max(2000,Math.ceil(Math.max(0,...rpm.map(p=>p[1]))/1000)*1000);
  lineChart($('statsTripRpm'),{series:[{name:'Motordrehzahl',color:COLOR.orange,unit:'1/min',points:rpm}],xMin:0,xMax:durMin,yMin:0,yMax:rTop,
    yTicks:Array.from({length:rTop/1000+1},(_,i)=>i*1000),yFmt:v=>fmtNum(v),yTitle:'1/min',xLabels:['0 min','Minute',fmtNum(durMin)+' min'],cursorFmt:x=>fmtNum(x)+' min',gapX:1,height:240,
    empty:'Keine Drehzahlwerte.'});
}
function renderStatsHeader(v){
  statsView=v;const s=v.status,mgu=v.mgu,set=v.settings;
  $('statsSubtitle').textContent=v.vehicleLabel+(s.lastStoredAt?' · Stand '+stamp(s.lastStoredAt):'');
  const rec=$('statsRecording');
  rec.textContent=!set.enabled?'Aufzeichnung aus':mgu?.tripActive?'Fahrt läuft':mgu?'Bereit':'MGU wartet';
  rec.className='pill '+(set.enabled&&mgu?'pill-live':'pill-off');
  const states={ok:'Daten aktuell',idle:'Noch nicht abgefragt',error:'Abruf fehlgeschlagen',agent_without_telemetry:'Companion Agent ab 0.2.14 nötig',
    app_without_recorder:'Vehicle Data ab 0.2.13 nötig',waiting_for_app:'Vehicle Data meldet sich noch nicht'};
  const parts=[states[s.state]||s.state];
  if(s.lastStoredAt)parts.push('zuletzt gespeichert '+stamp(s.lastStoredAt));
  if(Number.isInteger(s.mguPending)&&s.mguPending)parts.push(s.mguPending+' Pakete warten auf der MGU');
  if(mgu?.buffer?.dropped)parts.push(mgu.buffer.dropped+' Pakete wegen Pufferlimit gekürzt');
  if(s.lastError)parts.push(s.lastError);
  $('statsStatus').textContent=parts.join(' · ');
  $('statsEnabled').checked=set.enabled;$('statsVehicleName').value=set.vehicleName||'';
  $('statsIdleEnd').value=set.idleEndMin;$('statsBuffer').value=set.bufferMb;$('statsRawDays').value=set.rawDays;$('statsAggregateMonths').value=set.aggregateMonths;
  $('statsLimit').value=set.limitMb;$('statsOilThreshold').value=set.oilThresholdC;$('statsCoolantThreshold').value=set.coolantThresholdC;
  const db=v.database;
  $('statsStorage').textContent='Datenbank: '+fmtNum(db.bytes/1048576,1)+' MB von '+set.limitMb+' MB · '+fmtNum(db.samples)+' Messwerte · '+fmtNum(db.trips)+' Fahrten'+
    (db.oldestSample?' · Rohdaten seit '+fmtDay(db.oldestSample):'');
  const sel=$('statsTripCategory');
  if(sel.options.length<=1)v.categories.forEach(c=>sel.appendChild(new Option(c,c)));
  const list=$('statsSignals');list.replaceChildren();
  const VER={reference:'Skalierung belegt, am Fahrzeug noch nicht bestätigt',unverified:'Rohwert, Skalierung unbekannt',vehicle:'am Fahrzeug bestätigt'};
  (db.signals||[]).forEach(x=>{const row=txt('div','','list-row');row.appendChild(txt('span',x.nameDe+(x.unit&&x.unit!=='raw'?' ('+x.unit+')':'')));
    row.appendChild(txt('span',VER[x.verification]||x.verification,'pill '+(x.verification==='vehicle'?'pill-live':'pill-off')));list.appendChild(row);});
}
function renderTrips(){
  const box=$('statsTrips');box.replaceChildren();
  if(!statsTrips.length){box.appendChild(txt('p','Noch keine Fahrten aufgezeichnet. Die erste Fahrt erscheint, sobald Vehicle Data und der Companion Agent laufen und das Auto gefahren ist.','hint'));return;}
  statsTrips.forEach(t=>{
    const s=t.summary||{},row=txt('div','','list-row maintenance-row');
    row.appendChild(txt('strong',tripLabel(t)));
    row.appendChild(txt('span',[s.distanceKm!=null?fmtKm(s.distanceKm):null,fmtDur(s.durationMs),
      s.maxSpeedKmh!=null?'max. '+fmtNum(s.maxSpeedKmh)+' km/h':null,s.oil?.max!=null?'Öl max. '+fmtNum(s.oil.max)+' °C':null].filter(Boolean).join(' · '),'hint'));
    row.appendChild(txt('span',t.category||(t.status==='open'?'läuft':QUALITY[s.quality]||''),'pill '+(t.status==='open'?'pill-live':'pill-off')));
    row.onclick=()=>openTrip(t.id);
    box.appendChild(row);
  });
}
async function loadOverview(){
  const [from,to]=rangeBounds(statsRange);
  statsOverview=await api('/telemetry/overview?from='+from+'&to='+to);
  renderOverview();
  const latest=[...statsOverview.trips].reverse()[0];
  const trip=latest?{id:latest.id,start_ts:latest.start,end_ts:latest.end,name:latest.name}:statsTrips[0];
  await warmupChart($('statsWarmup'),trip,$('statsWarmupCaption'));
  if(trip&&!latest)$('statsWarmupCaption').textContent='Letzte Fahrt (außerhalb des Zeitraums) · Temperaturen in °C';
}
async function refreshStats(){
  try{
    renderStatsHeader(await api('/telemetry'));
    const d=await api('/telemetry/trips?limit=30');statsTrips=d.trips;renderTrips();
    $('statsMore').hidden=d.trips.length<30;
    await loadOverview();
  }catch(e){$('statsStatus').textContent='Statistiken nicht verfügbar: '+e.message;}
}
$('statsRange').querySelectorAll('button').forEach(b=>b.onclick=async()=>{
  statsRange=b.dataset.range;
  $('statsRange').querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b));
  try{await loadOverview();}catch(e){notice(e.message);}
});
async function openTrip(id){
  try{
    const {trip:t}=await api('/telemetry/trips/'+id);statsTripId=id;const s=t.summary||{};
    $('statsTrip').hidden=false;$('statsTripTitle').textContent=tripLabel(t);
    $('statsTripInfo').textContent=fmtDay(t.start_ts)+' '+fmtTime(t.start_ts)+(t.end_ts?' bis '+fmtTime(t.end_ts):' · läuft noch')+
      (t.start_km!=null?' · Start '+fmtNum(t.start_km)+' km':'')+(t.end_km!=null?' · Ende '+fmtNum(t.end_km)+' km':'')+(t.partial?' · Anfang nachträglich rekonstruiert':'');
    const box=$('statsTripValues');box.replaceChildren();
    statBox(box,'Strecke',s.distanceKm!=null?fmtKm(s.distanceKm):dash);
    statBox(box,'Dauer',fmtDur(s.durationMs));
    statBox(box,'In Bewegung',fmtDur(s.movingMs));
    statBox(box,'Stillstand',fmtDur(s.standstillMs));
    statBox(box,'Motorlaufzeit',fmtDur(s.engineMs));
    statBox(box,'Leerlauf',fmtDur(s.idleMs));
    statBox(box,'Ø in Bewegung',s.avgSpeedMovingKmh!=null?fmtNum(s.avgSpeedMovingKmh)+' km/h':dash);
    statBox(box,'Ø gesamt',s.avgSpeedKmh!=null?fmtNum(s.avgSpeedKmh)+' km/h':dash);
    statBox(box,'Höchstgeschwindigkeit',s.maxSpeedKmh!=null?fmtNum(s.maxSpeedKmh)+' km/h':dash);
    statBox(box,'Max. Drehzahl',s.maxRpm!=null?fmtNum(s.maxRpm)+' 1/min':dash);
    for(const [k,label] of [['coolant','Kühlmittel'],['oil','Motoröl']]){
      const x=s[k];
      statBox(box,label+' Start / max.',x?fmtNum(x.start)+' / '+fmtNum(x.max)+' °C':dash);
      statBox(box,label+' ≥ '+(x?.threshold??'')+' °C nach',x?.reached?fmtDur(x.reached.ms)+' · '+fmtKm(x.reached.km):x?'nicht erreicht':dash);
    }
    statBox(box,'Verbrauch',dash);
    const cov=s.coverage||{},filled=s.filledMs?.speed;
    $('statsTripQuality').textContent='Datenqualität: '+(QUALITY[s.quality]||dash)+' · Abdeckung Geschwindigkeit '+fmtNum((cov.speed||0)*100)+' %, Drehzahl '+fmtNum((cov.rpm||0)*100)+
      ' %, Temperaturen '+fmtNum((cov.oil||0)*100)+' %'+(filled?' (davon '+fmtDur(filled)+' Stillstand ohne neue Meldung fortgeführt)':'')+
      ' · Strecke aus '+(DIST_SOURCE[s.distanceSource]||dash);
    $('statsTripName').value=t.name||'';$('statsTripCategory').value=t.category||'';
    $('statsTrip').scrollIntoView({behavior:'smooth',block:'start'});
    await warmupChart($('statsTripWarmup'),t,null);
    await tripLineCharts(t);
  }catch(e){notice(e.message);}
}
$('refreshStats').onclick=async()=>{const b=$('refreshStats');b.disabled=true;try{renderStatsHeader(await api('/telemetry/pull','POST'));await refreshStats();}catch(e){notice(e.message);}finally{b.disabled=false;}};
$('statsMore').onclick=async()=>{try{const last=statsTrips[statsTrips.length-1];const d=await api('/telemetry/trips?limit=30&before='+last.start_ts);statsTrips=statsTrips.concat(d.trips);renderTrips();$('statsMore').hidden=d.trips.length<30;}catch(e){notice(e.message);}};
$('statsTripClose').onclick=()=>{$('statsTrip').hidden=true;statsTripId=null;};
$('statsTripSave').onclick=async()=>{if(!statsTripId)return;try{await api('/telemetry/trips/'+statsTripId,'POST',{name:$('statsTripName').value.trim(),category:$('statsTripCategory').value});notice('Gespeichert.');await refreshStats();await openTrip(statsTripId);}catch(e){notice(e.message);}};
$('statsTripDelete').onclick=async()=>{if(!statsTripId||!confirm('Diese Fahrt und ihre Messwerte endgültig löschen?'))return;try{await api('/telemetry/trips/'+statsTripId+'?confirm=1','DELETE');$('statsTrip').hidden=true;statsTripId=null;notice('Fahrt gelöscht.');await refreshStats();}catch(e){notice(e.message);}};
$('statsSaveSettings').onclick=async()=>{
  const n=id=>Number($(id).value);
  try{renderStatsHeader(await api('/telemetry/settings','POST',{enabled:$('statsEnabled').checked,vehicleName:$('statsVehicleName').value.trim(),idleEndMin:n('statsIdleEnd'),bufferMb:n('statsBuffer'),rawDays:n('statsRawDays'),
    aggregateMonths:n('statsAggregateMonths'),limitMb:n('statsLimit'),oilThresholdC:n('statsOilThreshold'),coolantThresholdC:n('statsCoolantThreshold')}));notice('Gespeichert. Die MGU übernimmt die Aufzeichnungseinstellungen bei der nächsten Verbindung.');}
  catch(e){notice(e.message);}
};
$('statsReset').onclick=async()=>{if(!confirm('Alle Fahrten und Messwerte dieses Fahrzeugs löschen? Wartung und Fehlerspeicher bleiben erhalten.'))return;
  try{renderStatsHeader(await api('/telemetry/reset','POST',{confirm:$('statsResetConfirm').value.trim()}));$('statsResetConfirm').value='';statsTrips=[];renderTrips();await loadOverview();notice('Statistik zurückgesetzt.');}catch(e){notice(e.message);}};

// ----- Freigaben: alles automatisch freigeben -----
function renderAutoApprove(a){
  $('autoApproveEnabled').checked=a.enabled;
  $('autoApproveInfo').textContent=a.enabled
    ?'An'+(a.until?' bis '+new Date(a.until).toLocaleString('de-DE',{weekday:'short',hour:'2-digit',minute:'2-digit'}):'')+': Jeder neue Auftrag von Claude oder aus dem Chat läuft sofort, auch Schreibbefehle als root.'
    :'Aus: Aufträge von Claude und aus dem Chat warten auf deine Freigabe.';
  $('autoApproveInfo').classList.toggle('error',a.enabled);
}
async function refreshAutoApprove(){try{renderAutoApprove(await api('/jobs/auto-approve'));}catch(e){}}
$('autoApproveEnabled').onchange=async()=>{
  const enabled=$('autoApproveEnabled').checked;
  try{renderAutoApprove(await api('/jobs/auto-approve','POST',{enabled,hours:Number($('autoApproveHours').value)||0}));refreshJobs();}
  catch(e){$('autoApproveEnabled').checked=!enabled;notice(e.message);}
};
refreshAutoApprove();

// ----- Diagnose: Logs und Fehler der MGU-Apps -----
let mguAppLogData=null,mguAppLogView='errors';
function appLabel(a){return (a.name||a.id||a.dir)+(a.version?' '+a.version:'');}
async function refreshMguApps(){
  const list=$('mguAppsList'),info=$('mguAppsInfo');
  info.textContent='Lade …';
  try{
    const d=await api('/mgu/apps');
    list.replaceChildren();
    const failing=d.apps.filter(a=>a.log.errors);
    info.textContent=d.apps.length+' Apps · '+(failing.length?failing.length+' mit Fehlern im Log':'keine Fehler in den Logs')+' · '+stamp(d.at);
    for(const a of d.apps){
      const row=txt('div','','list-row'),l=a.log;
      const head=txt('div','','request-info');
      head.appendChild(txt('strong',appLabel(a)));
      head.appendChild(txt('span',[a.id&&a.name?a.id:null,a.dir,l.file?'Log '+(l.lastAt?stamp(l.lastAt):'ohne Zeit'):'kein Log'].filter(Boolean).join(' · '),'hint'));
      row.appendChild(head);
      row.appendChild(txt('span',a.running.length?'läuft':'aus','pill '+(a.running.length?'pill-live':'pill-off')));
      if(l.errors||l.fatal)row.appendChild(txt('span',(l.fatal?l.fatal+' Abstürze · ':'')+l.errors+' Fehler','pill pill-bad'));
      if(l.warnings)row.appendChild(txt('span',l.warnings+' Warnungen','pill pill-off'));
      if(l.lastError)row.appendChild(txt('span',l.lastError,'app-last'));
      row.onclick=()=>openMguAppLog(a.dir,appLabel(a));
      list.appendChild(row);
    }
  }catch(e){info.textContent=consoleHumanError(e);}
}
function renderMguAppLog(){
  const d=mguAppLogData;if(!d)return;
  let text='';
  if(mguAppLogView==='errors')text=d.errors.length?d.errors.join('\n'):'Keine ERROR-, FATAL- oder WARN-Zeilen in den Logs.';
  if(mguAppLogView==='log')text=d.logs.length?d.logs.map(l=>'===== '+l.name+' ('+l.bytes+' Byte, '+stamp(l.modified)+')'+(l.cut?' · Ende':'')+'\n'+l.lines.join('\n')).join('\n\n'):'Keine Logdatei.';
  if(mguAppLogView==='reports')text=d.reports.length?d.reports.map(r=>'===== '+r.name+' ('+stamp(r.modified)+')\n'+r.text).join('\n\n'):'Keine Diagnose- oder Berichtsdateien.';
  if(mguAppLogView==='journal')text=d.journal.available?(d.journal.lines.join('\n')||'Keine Einträge zu dieser App im Systemjournal.'):'Systemjournal nicht verfügbar'+(d.journal.error?': '+d.journal.error:'.');
  if(d.skipped.length&&mguAppLogView!=='errors')text+='\n\nNicht ausgegeben: '+d.skipped.map(x=>x.name+' ('+x.reason+')').join(', ');
  $('mguAppLogText').textContent=text;
  $('mguAppLogView').querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.view===mguAppLogView));
}
async function openMguAppLog(app,label){
  $('mguAppLog').hidden=false;$('mguAppLogTitle').textContent=label;$('mguAppLogInfo').textContent='Lade …';$('mguAppLogText').textContent='';
  try{
    mguAppLogData=await api('/mgu/apps/logs','POST',{app,lines:1000});
    const s=mguAppLogData.summary;
    $('mguAppLogInfo').textContent=[mguAppLogData.running.length?'läuft (PID '+mguAppLogData.running.map(r=>r.pid).join(', ')+')':'läuft nicht',
      s.errors+' Fehler',s.fatal+' Abstürze',s.warnings+' Warnungen',mguAppLogData.reports.length+' Berichte'].join(' · ');
    mguAppLogView=s.errors||s.warnings?'errors':'log';
    renderMguAppLog();
    $('mguAppLog').scrollIntoView({behavior:'smooth',block:'start'});
  }catch(e){$('mguAppLogInfo').textContent=consoleHumanError(e);}
}
$('mguAppsRefresh').onclick=refreshMguApps;
$('mguAppLogClose').onclick=()=>{$('mguAppLog').hidden=true;mguAppLogData=null;};
$('mguAppLogView').querySelectorAll('button').forEach(b=>b.onclick=()=>{mguAppLogView=b.dataset.view;renderMguAppLog();});
$('mguAppLogDownload').onclick=()=>{
  const d=mguAppLogData;if(!d)return;
  const parts=['App: '+(d.app.id||d.app.dir)+' '+(d.app.version||'')+' ('+d.app.dir+') · gelesen '+d.at,'',
    '##### Fehler und Warnungen',d.errors.join('\n')||'(keine)','',
    ...d.logs.map(l=>'##### '+l.name+'\n'+l.lines.join('\n')),'',
    ...d.reports.map(r=>'##### '+r.name+'\n'+r.text),'',
    '##### Systemjournal',d.journal.lines.join('\n')||'(keine)'];
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([parts.join('\n')],{type:'text/plain'}));
  a.download=(d.app.id||d.app.dir)+'-logs-'+d.at.slice(0,19).replace(/[:T]/g,'-')+'.txt';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000);
};
