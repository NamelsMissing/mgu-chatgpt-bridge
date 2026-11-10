'use strict';
let key='',busy=false;
const $=s=>document.getElementById(s);
async function api(endpoint,body){const r=await fetch(endpoint,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const x=await r.json();if(!r.ok)throw Error(x.error||'Anfrage fehlgeschlagen');return x;}
function el(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function act(parent,label,fn){const b=el('button',label);b.onclick=async()=>{b.disabled=true;try{await fn();$('message').textContent='';}catch(e){$('message').textContent=e.message;}finally{b.disabled=false;}};parent.append(b);}
async function refresh(){
    if(busy)return;busy=true;
    try{const data=await api('/owner/state');$('devices').replaceChildren();$('jobs').replaceChildren();const selected=$('deviceSelect').value;$('deviceSelect').replaceChildren();
        for(const d of data.devices){const card=el('article');card.append(el('h3',d.label),el('p',d.revoked?'Zugriff widerrufen':d.lastSeen?'Letzter Kontakt: '+new Date(d.lastSeen).toLocaleString():'Noch kein Kontakt'),el('code',d.id));
            if(!d.revoked){const o=el('option',d.label);o.value=d.id;$('deviceSelect').append(o);act(card,'Zugriff widerrufen',async()=>{if(confirm('Zugriff für '+d.label+' widerrufen?')){await api('/owner/revoke',{deviceId:d.id});await refresh();}});} $('devices').append(card);}
        if(selected)$('deviceSelect').value=selected;
        for(const j of data.jobs){const card=el('article');card.append(el('span',j.status.toUpperCase(),'badge'),el('h3',j.operation.type==='shell'?'Shell-Befehl':j.operation.type==='file'?'Datei übertragen':j.operation.name),el('p',j.reason),el('p','Fahrzeug: '+j.deviceId),el('pre',JSON.stringify(j.operation,null,2)),el('small','Auftrag '+j.id+' · SHA-256 '+j.hash));
            if(j.status==='pending'){
                card.append(el('p',j.operation.type==='shell'?'Dieser Befehl kann Daten und Fahrzeugfunktionen verändern. Lies den gesamten Befehl.':'Die gezeigten Daten werden nach Freigabe an die verbundene ChatGPT-Anbindung übertragen.'));
                const check=el('input');check.type='checkbox';const label=el('label');label.append(check,document.createTextNode(' Ich habe diesen genauen Auftrag geprüft.'));card.append(label);
                act(card,'Einmalig freigeben',async()=>{if(!check.checked)throw Error('Bitte den genauen Auftrag prüfen und das Feld bestätigen.');await api('/owner/jobs/'+j.id+'/approve',{hash:j.hash});await refresh();});
                act(card,'Ablehnen',async()=>{await api('/owner/jobs/'+j.id+'/reject',{});await refresh();});
            }else if(j.status==='approved')act(card,'Freigabe zurückziehen',async()=>{await api('/owner/jobs/'+j.id+'/reject',{});await refresh();});
            if(j.result){const details=el('details');details.append(el('summary','Ergebnis anzeigen'),el('pre',JSON.stringify(j.result,null,2)));card.append(details);act(card,'Ergebnis herunterladen',async()=>{const blob=new Blob([JSON.stringify(j,null,2)],{type:'application/json'}),a=el('a');a.href=URL.createObjectURL(blob);a.download='mgu-result-'+j.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);});}
            $('jobs').append(card);
        }
    }finally{busy=false;}
}
function error(e){$('message').textContent=e.message;}
$('connect').onclick=async()=>{key=$('key').value;$('key').value='';try{await refresh();$('login').hidden=true;$('dashboard').hidden=false;}catch(e){key='';error(e);}};
$('logout').onclick=()=>{key='';$('dashboard').hidden=true;$('login').hidden=false;$('devices').replaceChildren();$('jobs').replaceChildren();$('pairing').textContent='';};
$('refresh').onclick=()=>refresh().catch(error);
$('pair').onclick=async()=>{try{const x=await api('/owner/pair',{label:$('label').value});$('pairing').textContent='Einmaliger Code (5 Minuten gültig):\n'+x.code+'\n\nAuf dem MGU ausführen:\nnode /var/opt/mgu-chatgpt-bridge/current/agent/agent.js pair '+x.server+' '+x.code+'\nsystemctl restart mgu-chatgpt-bridge.service';}catch(e){error(e);}};
$('test').onclick=async()=>{try{await api('/owner/propose',{deviceId:$('deviceSelect').value,operation:{type:'catalog',name:'system'},reason:'Verbindungstest: Systemversion und Laufzeit abfragen.'});await refresh();}catch(e){error(e);}};
// Explicit refresh preserves the user's current review checkbox and exact job preview.
