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
 const res=await fetch('/api/v1'+endpoint,{method,headers,body:raw?data:data?JSON.stringify(data):undefined});
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

// ----- Reiter -----
// Frühere Reiternamen (Lesezeichen, QR-Links, gespeicherte Ansicht) führen zum neuen Ort.
const TAB_ALIASES={status:'diag',reports:'diag',actions:'diag',logs:'system',updates:'system',service:'vehicle'};
function openTab(name){
 name=TAB_ALIASES[name]||name;
 const button=document.querySelector('#tabs [data-tab="'+name+'"]');if(!button)return;
 currentTab=name;
 if(name==='console')history.replaceState(null,'',location.pathname+location.search+'#console');
 document.querySelectorAll('section.tab').forEach(s=>s.hidden=s.id!==name);
 $('tabs').querySelectorAll('button').forEach(t=>t.classList.toggle('active',t===button));
 ({jobs:refreshJobs,vehicle:refreshVehicle,diag:refreshDiag,files:refreshFilesTab,system:refreshSystem,console:refreshConsoleConnection}[name]||(()=>{}))();
}
$('tabs').querySelectorAll('button').forEach(b=>b.onclick=()=>openTab(b.dataset.tab));

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
const JOB_TYPES={status:'MGU-Status abfragen',diagnostic:'Systemdiagnose',list:'Verzeichnis auflisten',download:'Datei abrufen',console:'Lesebefehl ausführen',action:'Fahrzeugfunktion'};
const JOB_STATES={pending:'Wartet auf Freigabe',running:'Läuft',done:'Erledigt',failed:'Fehlgeschlagen',rejected:'Abgelehnt',expired:'Abgelaufen'};
function setJobBadge(count){const b=$('jobBadge');b.textContent=String(count);b.hidden=!count;}
function jobCard(j){
 const fromClaude=j.source==='claude',payload=j.payload||{},detail=payload.command||payload.path||payload.preset||payload.action||'';
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
async function refreshJobs(){
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
let lastDiagView='',lastPendingJobs=-1;
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
  $('mguText').textContent=on?'MGU verbunden'+(d.mgu.host?' ('+d.mgu.host+')':''):'MGU nicht erreichbar'+(d.error?': '+String(d.error).slice(0,140):'');
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
let pendingConsoleId=null,consoleHistory=[],consoleHistoryIndex=0;
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
 consoleTranscript.push({kind,text:text.slice(0,40000)});
 consoleTranscript=consoleTranscript.slice(-90);
 try{sessionStorage.setItem(CONSOLE_TRANSCRIPT_KEY,JSON.stringify(consoleTranscript));}catch(e){}
}
function consoleRestore(){
 try{
  const saved=JSON.parse(sessionStorage.getItem(CONSOLE_TRANSCRIPT_KEY)||'[]');
  if(Array.isArray(saved))consoleTranscript=saved.filter(x=>x&&typeof x.text==='string'&&typeof x.kind==='string').slice(-90);
 }catch(e){consoleTranscript=[];}
 $('consoleOutput').replaceChildren();
 if(!consoleTranscript.length)consolePrint('BMW AI MGU · Lesemodus\nTippe „help“ ein oder wähle unten einen Schnellbefehl.','info');
 else for(const entry of consoleTranscript)consoleAddLine(entry.text,entry.kind);
}
function consoleSetResult(message,error=false){
 const el=$('consoleResult');el.textContent=message;el.classList.toggle('is-error',error);
}
function consoleCommandSafetyProblem(command){
 if(command.length>450)return 'Der Befehl ist zu lang (maximal 450 Zeichen).';
 const first=command.trim().split(/\s+/)[0].toLowerCase();
 const allowed=['help','pwd','uname','uptime','ip','ps','systemctl','ls','cat','head','tail','grep','find','strings','stat','sha256sum'];
 if(!allowed.includes(first))return 'Der Befehl „'+first+'“ wird hier nicht unterstützt. Nutze „help“ für erlaubte Lesebefehle.';
 let quote='';
 for(const ch of command){
  if(quote){if(ch===quote)quote='';continue;}
  if(ch==='"'||ch==="'"){quote=ch;continue;}
  if(/[;&|<>$\\]/.test(ch)||ch.charCodeAt(0)===96)
   return 'Shell-Schleifen, Pipes (|), Umleitungen (>) und Variablen sind nicht erlaubt. Gib einen einzelnen Lesebefehl ein. Für vollständige SSH-Befehle verwende die separate MGU-SSH-App.';
 }
 if(quote)return 'Anführungszeichen nicht geschlossen.';
 return '';
}
function consoleHumanError(err){
 const raw=String(err&&err.message||err||'Unbekannter Fehler');
 if(raw.includes('Shell operators not allowed'))return 'Shell-Operatoren sind hier gesperrt. Bitte keine Schleifen, Pipes oder Umleitungen verwenden.';
 if(raw.includes('Command not permitted'))return 'Befehl nicht freigegeben. Nutze „help“.';
 if(raw.includes('Path outside read-only allowlist'))return 'Pfad außerhalb der erlaubten Lesebereiche (/etc/cinemo, /etc/oap, /usr/lib, /var/log).';
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
 label.textContent='Prüfen ...';dot.className='console-dot';
 try{
  const d=await api('/status');
  if(d.mgu&&d.mgu.online===true){label.textContent='MGU verbunden';dot.className='console-dot is-online';}
  else{label.textContent='MGU nicht erreichbar';dot.className='console-dot is-offline';if(d.error)consoleSetResult('Verbindung: '+consoleHumanError(d.error),true);}
 }catch(err){label.textContent='Verbindung unklar';dot.className='console-dot is-offline';consoleSetResult(consoleHumanError(err),true);}
}
$('consoleRefreshConnection').onclick=refreshConsoleConnection;
$('consoleCommandForm').onsubmit=async event=>{
 event.preventDefault();
 if(pendingConsoleId)return consoleSetResult('Zuerst die offene Freigabe bestätigen oder abbrechen.',true);
 const command=$('consoleInput').value.trim();
 if(!command)return consoleSetResult('Gib zuerst einen Befehl ein.',true);
 const problem=consoleCommandSafetyProblem(command);
 consolePrint('mgu $ '+command,'cmd');
 if(problem){consolePrint('Nicht ausgeführt: '+problem,'error');consoleSetResult(problem,true);return;}
 consoleLock(true);consoleSetResult('Befehl wird zur Freigabe vorbereitet ...');
 try{
  const r=await api('/jobs','POST',{type:'console',payload:{command},reason:'MGU-Terminal (lesend): '+command});
  pendingConsoleId=r.job.id;
  $('consoleExact').textContent=command;$('consoleApproval').hidden=false;
  $('consoleInput').value='';
  consoleHistory.push(command);consoleHistory=consoleHistory.slice(-40);consoleHistoryIndex=consoleHistory.length;
  consolePrint('Wartet auf deine einmalige Freigabe.','info');
  consoleSetResult('Freigabe erforderlich – bitte Befehl prüfen.');
  $('consoleApprove').focus();
 }catch(err){const msg=consoleHumanError(err);consolePrint('FEHLER: '+msg,'error');consoleSetResult(msg,true);consoleLock(false);}
};
$('consoleInput').onkeydown=event=>{
 if(event.key==='ArrowUp'&&consoleHistory.length){event.preventDefault();consoleHistoryIndex=Math.max(0,consoleHistoryIndex-1);$('consoleInput').value=consoleHistory[consoleHistoryIndex];}
 else if(event.key==='ArrowDown'&&consoleHistory.length){event.preventDefault();consoleHistoryIndex=Math.min(consoleHistory.length,consoleHistoryIndex+1);$('consoleInput').value=consoleHistoryIndex===consoleHistory.length?'':consoleHistory[consoleHistoryIndex];}
};
$('consoleApprove').onclick=async()=>{
 if(!pendingConsoleId)return;
 const id=pendingConsoleId,button=$('consoleApprove');button.disabled=true;
 consoleSetResult('MGU führt den freigegebenen Lesebefehl aus ...');
 try{
  const d=await api('/jobs/'+id+'/approve','POST'),out=d.job.result||{};
  const content=typeof out.stdout==='string'?out.stdout:JSON.stringify(out,null,2);
  consolePrint(content||'(keine Ausgabe)',content.startsWith('[unavailable]')?'error':'output');
  consolePrint('Beendet · Exit-Code '+(out.exitCode===undefined?'unbekannt':out.exitCode),out.exitCode===0?'success':'error');
  consoleSetResult('Befehl abgeschlossen.');refreshJobs();
 }catch(err){const msg=consoleHumanError(err);consolePrint('FEHLER: '+msg,'error');consoleSetResult(msg,true);}
 finally{pendingConsoleId=null;$('consoleApproval').hidden=true;consoleLock(false);button.disabled=false;$('consoleInput').focus();}
};
$('consoleReject').onclick=async()=>{
 if(!pendingConsoleId)return;
 const id=pendingConsoleId;$('consoleReject').disabled=true;
 try{await api('/jobs/'+id+'/reject','POST');consolePrint('Abgebrochen – nichts ausgeführt.','info');consoleSetResult('Befehl nicht ausgeführt.');}
 catch(err){const msg=consoleHumanError(err);consolePrint('Freigabe: '+msg,'error');consoleSetResult(msg,true);}
 finally{pendingConsoleId=null;$('consoleApproval').hidden=true;$('consoleReject').disabled=false;consoleLock(false);$('consoleInput').focus();}
};
document.querySelectorAll('[data-console-command]').forEach(button=>{
 button.onclick=()=>{
  const input=$('consoleInput');if(input.disabled)return;
  input.value=button.dataset.consoleCommand||'';input.focus();
  consoleSetResult('Befehl eingetragen. Mit „Ausführen“ anfragen.');
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
const DUE_STATES={overdue:'Überfällig',soon:'Bald fällig',ok:'In Ordnung',unknown:'Noch kein Eintrag'};
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
 const m=v.mileage;
 $('mileageNow').textContent=m?kmText(m.km):'Noch kein Kilometerstand';
 $('mileageSource').textContent=m?MILEAGE_SOURCES[m.source]||m.source:'–';
 $('mileageSource').className='pill '+(m&&m.source==='vehicle'?'pill-live':'pill-off');
 $('mileageInfo').textContent=m?'Stand vom '+dateText(m.date)+(v.kmPerDay?' · Ø '+v.kmPerDay.toLocaleString('de-DE')+' km pro Tag im letzten Jahr':''):'Trag den aktuellen Stand ein. Er ist die Grundlage für die km-Fälligkeiten.';
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

 const due=$('dueList');due.replaceChildren();
 for(const d of v.due){
  const card=txt('div','','due due-'+d.status),head=txt('div','','job-head');
  head.appendChild(txt('strong',d.name));head.appendChild(txt('span',DUE_STATES[d.status],'pill due-pill-'+d.status));
  if(d.override)head.appendChild(txt('span','feste Fälligkeit','pill pill-off'));
  card.appendChild(head);
  if(d.status==='unknown')card.appendChild(txt('p',d.override?'':'Trag die letzte Durchführung im Serviceheft ein, dann wird die Fälligkeit berechnet.','hint'));
  else{
   card.appendChild(txt('p','Fällig '+dueLine(d)));
   if(d.estimatedKmDate&&d.kmLeft>=0)card.appendChild(txt('p','km-Grenze voraussichtlich um den '+dateText(d.estimatedKmDate)+' (Schätzung aus deinem Durchschnitt)','hint'));
  }
  const meta=[];
  if(d.intervalMonths||d.intervalKm)meta.push('Intervall: '+[d.intervalMonths?plural(d.intervalMonths,'Monat','Monate'):'',d.intervalKm?kmText(d.intervalKm):''].filter(Boolean).join(' oder '));
  if(d.lastDone)meta.push('zuletzt '+dateText(d.lastDone.date)+(d.lastDone.km!==null?' bei '+kmText(d.lastDone.km):''));
  if(meta.length)card.appendChild(txt('p',meta.join(' · '),'hint'));
  const edit=txt('button','Ändern','textbutton');edit.onclick=()=>editItem(d.id);card.appendChild(edit);
  due.appendChild(card);
 }

 const items=$('entryItems'),checked=new Set([...items.querySelectorAll('input:checked')].map(i=>i.value));items.replaceChildren();
 for(const it of v.items){const l=document.createElement('label');l.className='check';const c=document.createElement('input');c.type='checkbox';c.value=it.id;c.checked=checked.has(it.id);l.append(c,document.createTextNode(' '+it.name));items.appendChild(l);}

 const list=$('serviceEntries');list.replaceChildren();
 if(!v.entries.length)list.appendChild(txt('p','Noch keine Serviceeinträge.','hint'));
 const names=Object.fromEntries(v.items.map(i=>[i.id,i.name]));
 for(const e of v.entries){
  const card=txt('div','','service-entry'),head=txt('div','','job-head');
  head.appendChild(txt('strong',dateText(e.date)));
  if(e.km!==null)head.appendChild(txt('span',kmText(e.km),'hint'));
  if(e.cost!==null)head.appendChild(txt('span',e.cost.toLocaleString('de-DE',{style:'currency',currency:'EUR'}),'job-state'));
  card.appendChild(head);
  const what=[...e.items.map(i=>names[i]||'gelöschte Wartungsart'),e.title].filter(Boolean).join(' · ');
  card.appendChild(txt('p',what));
  if(e.workshop)card.appendChild(txt('p',e.workshop,'hint'));
  if(e.notes)card.appendChild(txt('p',e.notes,'hint notes'));
  const b=txt('button','Bearbeiten','textbutton');b.onclick=()=>editEntry(e.id);card.appendChild(b);
  list.appendChild(card);
 }
}
async function refreshVehicle(){
 if(!token)return;
 try{renderVehicle(await api('/vehicle'));}catch(e){notice(e.message);}
 // Liefert der MGU-Agent einen Kilometerstand, übernimmt der Server ihn dabei.
 try{
  const s=await api('/status'),veh=s.mgu&&s.mgu.vehicle;
  $('vehicleLive').textContent=!s.mgu?'MGU nicht erreichbar: '+String(s.error||'').slice(0,120)
   :veh&&Number.isInteger(veh.mileageKm)?'Live vom Fahrzeug: '+kmText(veh.mileageKm)
   :'Live-Daten vom Fahrzeug: noch keine Quelle auf der MGU ('+((veh&&veh.reason)||'kein geprüfter Fahrzeugsignal-Adapter')+'). Bis dahin zählt dein eingetragener Stand.';
  if(veh&&Number.isInteger(veh.mileageKm))renderVehicle(await api('/vehicle'));
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
 $('itemId').value=it?it.id:'';$('itemName').value=it?it.name:'';
 $('itemMonths').value=it?it.intervalMonths||0:'';$('itemKm').value=it?it.intervalKm||0:'';
 const d=it&&vehicleData.due.find(x=>x.id===id),o=d&&d.override;
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
function mguFileRow(fullPath,bytes,kind){
 const row=txt('div','','list-row'),name=fullPath.split('/').pop();
 if(kind==='directory'){
  const b=txt('button','📁 '+name,'linkbutton');b.onclick=()=>browseMgu(fullPath);row.appendChild(b);
  return row;
 }
 const info=txt('div','','request-info');info.appendChild(txt('span',name));
 info.appendChild(txt('span',[sizeText(bytes),kind==='symlink'?'Verknüpfung (nicht lesbar)':''].filter(Boolean).join(' · ')||fullPath,'hint'));
 row.appendChild(info);
 if(kind==='file'||kind===undefined){
  const dl=txt('button','Herunterladen','secondary');
  dl.onclick=async()=>{const f=await fetchFromMgu(fullPath,isLogName(name)||fullPath.startsWith('/var/log/')?'log':'mgu',dl);if(f)authenticatedDownload('/files/'+f.id+'/download',f.name);};
  row.appendChild(dl);
  if(isLogName(name)||fullPath.startsWith('/var/log/')){const lg=txt('button','Als Log speichern','textbutton');lg.onclick=()=>fetchFromMgu(fullPath,'log',lg);row.appendChild(lg);}
 }
 return row;
}
function renderCrumbs(p){
 const c=$('mguCrumbs');c.replaceChildren();if(!p)return;
 const root=mguRootsList.find(r=>p===r||p.startsWith(r+'/'))||p,rest=p.slice(root.length).split('/').filter(Boolean);
 let acc=root;const add=(label,target)=>{const b=txt('button',label,'linkbutton');b.onclick=()=>browseMgu(target);c.appendChild(b);};
 add(root,root);for(const seg of rest){acc+='/'+seg;c.appendChild(txt('span','/','hint'));add(seg,acc);}
}
async function browseMgu(p){
 const box=$('mguListing');box.replaceChildren(txt('p','Lade '+p+' …','hint'));
 try{
  const d=await api('/mgu/browse','POST',{path:p});mguCurrent=d.path||p;renderCrumbs(mguCurrent);box.replaceChildren();
  const root=mguRootsList.find(r=>mguCurrent===r||mguCurrent.startsWith(r+'/'));if(root)$('mguSearchRoot').value=root;
  const entries=[...(d.entries||[])].sort((a,b)=>(a.kind==='directory'?0:1)-(b.kind==='directory'?0:1)||a.name.localeCompare(b.name));
  if(!entries.length)box.appendChild(txt('p','Ordner ist leer.','hint'));
  for(const e of entries)box.appendChild(mguFileRow(mguCurrent+'/'+e.name,e.bytes,e.kind));
  if(entries.length>=200)box.appendChild(txt('p','Nur die ersten 200 Einträge. Nutze die Suche.','hint'));
 }catch(e){box.replaceChildren(txt('p',e.message,'error'));}
}
$('mguSearch').onclick=async()=>{
 const term=$('mguSearchTerm').value.trim(),root=$('mguSearchRoot').value,box=$('mguListing');
 if(term.length<2)return notice('Mindestens 2 Zeichen eingeben.');
 box.replaceChildren(txt('p','Suche „'+term+'“ in '+root+' …','hint'));$('mguCrumbs').replaceChildren(txt('span','Suchergebnisse in '+root,'hint'));
 try{
  const d=await api('/mgu/search','POST',{root,term});box.replaceChildren();
  if(!d.results.length)box.appendChild(txt('p','Nichts gefunden (bis 4 Ebenen tief).','hint'));
  for(const r of d.results){
   const row=mguFileRow(r,null,undefined),open=txt('button','Ordner öffnen','textbutton');
   open.onclick=()=>browseMgu(r.slice(0,r.lastIndexOf('/'))||root);row.appendChild(open);box.appendChild(row);
  }
  if(d.truncated)box.appendChild(txt('p','Mehr als 180 Treffer, bitte genauer suchen.','hint'));
 }catch(e){box.replaceChildren(txt('p',e.message,'error'));}
};
$('mguSearchTerm').onkeydown=e=>{if(e.key==='Enter')$('mguSearch').click();};
async function loadMguRoots(){
 if(mguRootsList.length)return;
 try{
  mguRootsList=(await api('/mgu/roots')).roots;
  const chips=$('mguRoots'),sel=$('mguSearchRoot');chips.replaceChildren();sel.replaceChildren();
  for(const r of mguRootsList){const b=txt('button',r,'console-chip');b.onclick=()=>browseMgu(r);chips.appendChild(b);sel.appendChild(new Option(r,r));}
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
function refreshSystem(){refreshUpdates();refreshLogs();}

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
  if(typeof pendingConsoleId!=='undefined'&&pendingConsoleId)return true;
  if(typeof pendingUpdate!=='undefined'&&pendingUpdate)return true;
  if($('consoleApproval')&&!$('consoleApproval').hidden)return true;
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
