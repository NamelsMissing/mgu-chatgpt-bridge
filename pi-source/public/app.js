'use strict';
let token=sessionStorage.getItem('bmw-ai-token')||'',conversationId='',currentTab='chat';
function authHeaders(){return token==='cookie'?{'x-bmw-ai-client':'1'}:{authorization:'Bearer '+token,'x-bmw-ai-client':'1'};}
const $=s=>document.getElementById(s);const txt=(tag,value,cls)=>{const e=document.createElement(tag);if(cls)e.className=cls;e.textContent=String(value);return e;};
function notice(s){$('notice').textContent=s;}
async function api(endpoint,method='GET',data,raw){const headers=authHeaders();if(data&&!raw)headers['content-type']='application/json';const res=await fetch('/api/v1'+endpoint,{method,headers,body:raw?data:data?JSON.stringify(data):undefined});const result=await res.json().catch(()=>({error:'Invalid response'}));if(!res.ok)throw Error(result.error||'HTTP '+res.status);return result;}
const pairParams=new URLSearchParams(location.search);
const pendingPair=(location.pathname==='/pair'&&/^[0-9a-f]{32}$/.test(pairParams.get('code')||'')&&/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(?:\d{1,3}\.)\d{1,3}$/.test(pairParams.get('ip')||''))?{ip:pairParams.get('ip'),code:pairParams.get('code')}:null;
if(location.pathname==='/pair')history.replaceState(null,'','/');
function renderPair(){const panel=$('pairPanel');panel.hidden=!pendingPair;if(pendingPair){$('pairDescription').textContent='Neue BMW-MGU mit Tailscale-Adresse '+pendingPair.ip+' koppeln? Die Kopplung erfolgt nur nach deiner ausdruecklichen Bestaetigung.';}}
$('pairButton').onclick=async()=>{if(!pendingPair||!token)return;const btn=$('pairButton');btn.disabled=true;try{const d=await api('/pair','POST',pendingPair);$('pairDescription').textContent='Erfolgreich gekoppelt: '+d.host;$('pairError').textContent='';btn.hidden=true;await refreshStatus();}catch(e){$('pairError').textContent=e.message;btn.disabled=false;}};
function show(){ $('login').hidden=!!token;$('shell').hidden=!token;if(token){refreshConvos();refreshJobs();refreshPlanStatus();if(pendingPair){document.querySelector('[data-tab="status"]').click();renderPair();}}}
$('loginButton').onclick=async()=>{try{const r=await fetch('/api/v1/login',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-bmw-ai-client':'1'},body:JSON.stringify({password:$('password').value,remember:$('rememberMe').checked})});const d=await r.json();if(!r.ok)throw Error(d.error);
 token=d.remembered?'cookie':d.token;if(d.remembered)sessionStorage.removeItem('bmw-ai-token');else sessionStorage.setItem('bmw-ai-token',token);
 $('password').value='';$('loginError').textContent='';show();}catch(e){$('loginError').textContent=e.message;}};
$('logout').onclick=async()=>{try{await api('/logout','POST');}catch(e){}token='';sessionStorage.removeItem('bmw-ai-token');show();};
$('tabs').querySelectorAll('button').forEach(b=>b.onclick=()=>{currentTab=b.dataset.tab;document.querySelectorAll('section.tab').forEach(s=>s.hidden=s.id!==currentTab);$('tabs').querySelectorAll('button').forEach(t=>t.classList.toggle('active',t===b));({status:refreshStatus,jobs:refreshJobs,files:refreshFiles,reports:refreshReports,logs:refreshLogs}[currentTab]||(()=>{}))();});
let pendingConsoleId=null;
function consolePrint(text){const p=$('consoleOutput');p.textContent+=(p.textContent?'\n':'')+String(text);p.scrollTop=p.scrollHeight;}
$('consoleSend').onclick=async()=>{const command=$('consoleInput').value.trim();if(!command)return;const btn=$('consoleSend');btn.disabled=true;
 try{const r=await api('/jobs','POST',{type:'console',payload:{command},reason:'MGU-Konsole (lesend): '+command});pendingConsoleId=r.job.id;$('consoleExact').textContent=command;$('consoleApproval').hidden=false;consolePrint('mgu $ '+command+'\n[Wartet auf deine einmalige Freigabe]');$('consoleInput').value='';notice('Prüfe den exakten Befehl und bestätige ihn.');}
 catch(e){notice(e.message);}finally{btn.disabled=false;}};
$('consoleInput').onkeydown=e=>{if(e.key==='Enter'){$('consoleSend').click();}};
$('consoleApprove').onclick=async()=>{if(!pendingConsoleId)return;const id=pendingConsoleId;$('consoleApprove').disabled=true;
 try{const r=await api('/jobs/'+id+'/approve','POST');const out=r.job.result||{};consolePrint(out.stdout||JSON.stringify(out,null,2));consolePrint('[exit '+String(out.exitCode===undefined?'?':out.exitCode)+']');$('consoleApproval').hidden=true;pendingConsoleId=null;refreshJobs();}catch(e){consolePrint('ERROR: '+e.message);notice(e.message);$('consoleApproval').hidden=true;pendingConsoleId=null;refreshJobs();}finally{$('consoleApprove').disabled=false;}};
$('consoleReject').onclick=async()=>{if(!pendingConsoleId)return;try{await api('/jobs/'+pendingConsoleId+'/reject','POST');consolePrint('[Abgelehnt]');$('consoleApproval').hidden=true;pendingConsoleId=null;refreshJobs();}catch(e){notice(e.message);}};
$('consoleClear').onclick=()=>{$('consoleOutput').textContent='';};
$('consoleCopy').onclick=async()=>{const t=$('consoleOutput').textContent;try{await navigator.clipboard.writeText(t);notice('Konsolenausgabe kopiert.');}catch(e){notice('Kopieren nicht möglich: '+e.message);}};
$('consoleExport').onclick=()=>{const blob=new Blob([$('consoleOutput').textContent],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='bmw-ai-mgu-console-'+new Date().toISOString().slice(0,10)+'.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1200);};
async function refreshConvos(){try{const data=await api('/conversations'),sel=$('convos');sel.replaceChildren();sel.appendChild(new Option('Neuer Chat',''));data.conversations.forEach(c=>sel.appendChild(new Option((c.importSource==='ChatGPT'?'[ChatGPT-Import] ':'')+c.title,c.id)));sel.value=conversationId;if(conversationId)await loadMessages();}catch(e){notice(e.message);}}
function addMessage(m){const node=txt('div',m.content,'message '+m.role);node.prepend(txt('span',m.role==='user'?'Du':'Assistent','meta'));$('messages').appendChild(node);$('messages').scrollTop=$('messages').scrollHeight;}
async function loadMessages(){$('messages').replaceChildren();if(!conversationId)return;const d=await api('/conversations/'+conversationId+'/messages');d.messages.forEach(addMessage);}
async function refreshPlanStatus(){try{const c=await api('/config');const p=c.chatgptPlan||{};$('chatgptPlanStatus').textContent=p.permission?'ChatGPT-Plus-Anmeldung aktiv'+(p.email?' ('+p.email+')':'')+' – Nutzung über das Abo, kein zusätzlicher API-Schlüssel.':p.connected?'ChatGPT-Konto angemeldet, Planfreigabe fehlt. OAuth-Anmeldung erneut durchführen.': 'ChatGPT-Plan nicht verbunden. OAuth-Anmeldung auf dem Raspberry Pi über Termius starten.';}catch(e){$('chatgptPlanStatus').textContent='Planstatus unbekannt: '+e.message;}}
$('newChat').onclick=()=>{conversationId='';$('convos').value='';$('messages').replaceChildren();notice('Neuer Chat');};
$('convos').onchange=()=>{conversationId=$('convos').value;loadMessages().catch(e=>notice(e.message));};
$('sendChat').onclick=async()=>{const v=$('chatInput').value.trim();if(!v)return;const btn=$('sendChat');btn.disabled=true;notice('OpenAI wird angefragt ...');try{const d=await api('/chat','POST',{message:v,conversationId:conversationId||undefined,fileId:$('chatFile').value||undefined});$('chatInput').value='';conversationId=d.conversationId;await refreshConvos();notice(d.pendingJob?'Freigabe in „Freigaben“ erforderlich.':'Antwort erhalten');if(d.pendingJob)refreshJobs();}catch(e){notice(e.message);}finally{btn.disabled=false;}};
$('chatInput').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('sendChat').click();}};
async function refreshStatus(){try{$('statusResult').textContent=JSON.stringify(await api('/status'),null,2);}catch(e){notice(e.message);}}
$('refreshStatus').onclick=refreshStatus;
$('createDiag').onclick=async()=>{try{await api('/jobs','POST',{type:'diagnostic',payload:{preset:$('preset').value},reason:'Manuelle Diagnose '+$('preset').value});notice('Auftrag erstellt; jetzt unter Freigaben bestätigen.');}catch(e){notice(e.message);}};
async function refreshJobs(){if(!token)return;try{const d=await api('/jobs'),root=$('jobList');root.replaceChildren();d.jobs.slice(0,60).forEach(j=>{const panel=txt('div','','panel');panel.appendChild(txt('strong',j.type+' • '+j.status));panel.appendChild(txt('p',j.reason));panel.appendChild(txt('pre',JSON.stringify(j.payload)));if(j.status==='pending'){const actions=txt('div','','actions');for(const choice of ['approve','reject']){const b=txt('button',choice==='approve'?'Einmalig freigeben':'Ablehnen',choice==='reject'?'danger':'');b.onclick=async()=>{b.disabled=true;try{await api('/jobs/'+j.id+'/'+choice,'POST');notice('Auftrag '+choice+' abgeschlossen.');await refreshJobs();if(choice==='approve'){refreshReports();refreshFiles();loadMessages().catch(()=>{});}}catch(e){notice(e.message);b.disabled=false;}};actions.appendChild(b);}panel.appendChild(actions);}if(j.status==='done'||j.status==='failed')panel.appendChild(txt('pre',JSON.stringify(j.result||j.error,null,2).slice(0,10000)));root.appendChild(panel);});}catch(e){notice(e.message);}}
$('refreshJobs').onclick=refreshJobs;
async function refreshFiles(){try{const d=await api('/files'),root=$('fileList');root.replaceChildren();const select=$('chatFile');const previous=select.value;select.replaceChildren(new Option('Ohne Datei',''));d.files.filter(f=>/\.(txt|json|log|xml|csv|md|ini|conf)$/i.test(f.name)&&f.bytes<=131072).forEach(f=>select.appendChild(new Option('Datei analysieren: '+f.name,f.id)));select.value=previous;d.files.forEach(f=>{const panel=txt('div','','panel');panel.appendChild(txt('strong',f.name));panel.appendChild(txt('p',f.bytes+' Bytes • '+f.source));const b=txt('button','Herunterladen');b.onclick=async()=>{const r=await fetch('/api/v1/files/'+f.id+'/download',{headers:authHeaders()});if(!r.ok)return notice('Download: HTTP '+r.status);const blob=await r.blob(),link=document.createElement('a'),url=URL.createObjectURL(blob);link.href=url;link.download=f.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};panel.appendChild(b);root.appendChild(panel);});}catch(e){notice(e.message);}}
$('uploadBtn').onclick=async()=>{const f=$('upload').files[0];if(!f)return notice('Datei auswählen');if(f.size>8*1024*1024)return notice('Maximal 8 MiB');try{const r=await fetch('/api/v1/files?name='+encodeURIComponent(f.name),{method:'POST',headers:authHeaders(),body:f});if(!r.ok)throw Error('Upload HTTP '+r.status);notice('Datei hochgeladen');refreshFiles();}catch(e){notice(e.message);}};
$('fetchFile').onclick=()=>requestFile('download',$('mguFilePath').value);
$('listFolder').onclick=()=>requestFile('list',$('mguFolderPath').value);
async function requestFile(type,p){try{await api('/jobs','POST',{type,payload:{path:p},reason:type+': '+p});notice('Datei-Auftrag erzeugt. Unter Freigaben bestätigen.');}catch(e){notice(e.message);}}
async function refreshReports(){try{const d=await api('/reports'),root=$('reportList');root.replaceChildren();d.reports.forEach(r=>{const p=txt('div','','panel');p.appendChild(txt('strong',r.title));p.appendChild(txt('p',r.createdAt+' • '+r.source));p.appendChild(txt('pre',JSON.stringify(r.result,null,2)));const a=document.createElement('a');a.textContent='JSON herunterladen';a.href='#';a.onclick=async e=>{e.preventDefault();await authenticatedDownload('/reports/'+r.id+'/download','diagnose-'+r.id+'.json');};p.appendChild(a);root.appendChild(p);});}catch(e){notice(e.message);}}
$('refreshReports').onclick=refreshReports;
async function refreshLogs(){try{$('logsResult').textContent=JSON.stringify((await api('/logs')).logs,null,2);}catch(e){notice(e.message);}}
$('refreshLogs').onclick=refreshLogs;
$('downloadLogs').onclick=()=>authenticatedDownload('/logs/download','bmw-ai-logs.json');
async function authenticatedDownload(path,name){try{const r=await fetch('/api/v1'+path,{headers:authHeaders()});if(!r.ok)throw Error('HTTP '+r.status);const u=URL.createObjectURL(await r.blob()),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}catch(e){notice(e.message);}}
async function restoreSession(){
 if(token){try{await api('/session');show();return;}catch(e){token='';sessionStorage.removeItem('bmw-ai-token');}}
 try{const r=await fetch('/api/v1/session',{credentials:'same-origin',headers:{'x-bmw-ai-client':'1'}});if(r.ok){token='cookie';show();return;}}catch(e){}
 show();
}
restoreSession();
// Native iPhone/iPad shell may inject a confirmed speech transcript here.
window.bmwAIInjectTranscript=function(text){$('chatInput').value=String(text||'').slice(0,8000);$('chatInput').focus();};

renderPair();

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

// ----- Browser-initiated, separately signed Raspberry Pi updates -----
async function refreshUpdates(){
  if(!token)return;
  try{const d=await api('/updates');$('updateStatus').textContent=JSON.stringify(d,null,2);
    $('autoUpdate').checked=d.auto===true;
  }catch(e){$('updateStatus').textContent='Updater: '+e.message;}
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
 const el=$('autoUpdate');el.disabled=true;
 try{const r=await api('/updates/automatic','POST',{enabled:el.checked});notice(r.auto?'Automatische signierte Updates aktiviert.':'Automatische Updates deaktiviert.');}
 catch(e){notice('Automatische Updates: '+e.message);el.checked=!el.checked;}
 finally{el.disabled=false;refreshUpdates();}
};
