'use strict';

const fs=require('node:fs');
const crypto=require('node:crypto');
const API='https://api.github.com/repos/';
const REPORT_PATH='diagnostics/latest.json';
const MIN_INTERVAL=5*60*1000;
const REPO_NAME=/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i;
const TOKEN=/^github_pat_[A-Za-z0-9_]{20,248}$/;
const SOURCES=[
 'SecureMileage.mileage','MileageSupreme.mileageSupreme','VehicleInformation.Range','UDS.558E',
 'TPMSInternalData.tpmsInternalLastValues','TPMS.statusTyrePressure','TPMS.statusTargetTyrePressure',
 'UDS.DC98','UDS.DC99','UDS.DC9A','UDS.DC9B','CheckControlMaster.basicList','KombiInterface_2.ccList',
 'KombiInterface_2.cbsDataServiceList','ServiceHistory.readServiceHistory','UDS.DPF','UDS.1902',
];
const STAGES=['not_configured','not_requested','pending','ok','failed','paused'];
const STATES=['running','stale','unknown','not_detected','no_snapshot','snapshot_error','storage_unavailable'];
const CONNECTIONS=['reachable','unreachable','unconfigured','invalid_response','agent_http_error'];
const REASONS=['unexpected_shape_or_type','invalid_value','qualifier_unavailable','no_reply','unexpected_reply',
 'unexpected_reply_length','transport_or_queue'];
const ENDPOINTS=['/v1/status','/v1/vehicle/fault-memory','/v1/vehicle/capabilities'];
const OUTCOMES=['Antwort empfangen','Timeout','Verbindungsfehler','HTTP-Fehler','Vehicle Data nicht gefunden','Snapshot fehlt',
 'Heartbeat veraltet','Snapshot fehlerhaft','OAP-Verzeichnis nicht erreichbar','Lokale Übergabe fehlgeschlagen','Diagnose-Timeout','Abfrage läuft'];

const known=(value,choices)=>choices.includes(value)?value:null;
const bool=value=>typeof value==='boolean'?value:null;
const httpStatus=value=>Number.isInteger(value)&&value>=100&&value<=599?value:null;
const iso=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)&&Number.isFinite(Date.parse(value))?
 new Date(value).toISOString():null;
const version=value=>typeof value==='string'&&/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)?value:null;
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function report(poll,transport,serverVersion,at){
 const connection=known(poll.connection,CONNECTIONS);
 if(!connection)return null;
 const versions={pi:version(serverVersion),agent:version(poll.versions?.agent),vehicleData:version(poll.versions?.vehicleDataRunning)};
 const appState=known(poll.appState,STATES),vehicle=known(poll.vehicle,['ok','waiting','unavailable']);
 const status={connection,httpStatus:httpStatus(poll.httpStatus),appState,vehicle,versions};
 const sources={},sourceTimes={};
 // Previous stage data remains in the Pi cache while the MGU is offline.
 // Include it as historical timing, without combining it with a live state.
 if(connection==='reachable'){
  for(const name of SOURCES){
   const row=poll.stages?.[name], received=poll.received?.[name];
   const family=poll.stages?.[name.split('.')[0]];
   if(!row&&!received)continue;
   const reason=typeof row?.decodeReason==='string'&&/^nrc_[0-9A-F]{2}$/.test(row.decodeReason)?
    row.decodeReason:known(row?.decodeReason,REASONS);
   const state={
    manifestRead:bool(row?.manifestRead),manifestSubscribe:bool(row?.manifestSubscribe),
    provider:bool(family?.provider),getter:known(row?.getter,STAGES),
    subscription:known(row?.subscription,STAGES),valid:bool(received?.valid),reason,
   };
   sources[name]=state;
   sourceTimes[name]={lastResponseAt:iso(received?.at),lastValidAt:iso(received?.validAt)};
  }
 }
 const latest=new Map();
 for(const entry of transport){
  const endpoint=known(entry?.endpoint,ENDPOINTS),outcome=known(entry?.outcome,OUTCOMES);
  if(endpoint&&outcome)latest.set(endpoint,{status:httpStatus(entry.status),outcome,at:iso(entry.at)});
 }
 const requests=Object.fromEntries(ENDPOINTS.filter(endpoint=>latest.has(endpoint)).map(endpoint=>[endpoint,latest.get(endpoint)]));
 const requestStates=Object.fromEntries(Object.entries(requests).map(([endpoint,{status,outcome}])=>[endpoint,{status,outcome}]));
 const problem=connection!=='reachable'||appState!=='running'||vehicle!=='ok'||
  Object.values(sources).some(row=>row.valid===false||row.getter==='failed'||row.getter==='paused'||row.subscription==='failed')||
  Object.values(requestStates).some(row=>row.outcome!=='Antwort empfangen');
 const fingerprint=digest({status,sources,requests:requestStates});
 return {schema:1,at,fingerprint,problem,status,sources,sourceTimes,requests,
  lastAgentSuccessAt:iso(poll.lastOk),lastSnapshotAt:iso(poll.transfer?.snapshotAt),lastPiReceiptAt:iso(poll.transfer?.piReceivedAt)};
}

function publisher(file,{request=fetch,clock=Date.now}={}){
 let config={};
 try{const parsed=JSON.parse(fs.readFileSync(file,'utf8'));if(parsed&&typeof parsed==='object')config=parsed;}catch(e){}
 let running=null,lastAttempt=Date.parse(config.lastAttemptAt)||0;
 const now=()=>new Date(clock()).toISOString();
 function persist(next){
  const temp=file+'.'+crypto.randomUUID()+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(next),{mode:0o600,flag:'wx'});
  try{fs.renameSync(temp,file);}catch(e){fs.rmSync(temp,{force:true});throw e;}
  config=next;
 }
 const credentials=()=>REPO_NAME.test(config.repo||'')&&TOKEN.test(config.token||'');
 function view(){
  return {repo:config.repo||'',enabled:config.enabled===true,hasToken:TOKEN.test(config.token||''),
   lastSuccessAt:config.lastSuccessAt||null,lastError:config.lastError||null,lastAttemptAt:config.lastAttemptAt||null,sending:!!running};
 }
 function configure({repo,token,enabled}){
  if(typeof enabled!=='boolean'||typeof repo!=='string'||(repo&&!REPO_NAME.test(repo))||typeof token!=='string'||
    (token&&!TOKEN.test(token)))throw Error('GitHub-Repository oder Fine-grained Token ist ungültig.');
  const oldRepo=config.repo||'';
  const sameRepo=repo.toLowerCase()===oldRepo.toLowerCase();
  const credential=token||(sameRepo?config.token:'');
  if(enabled&&(!repo||!TOKEN.test(credential||'')))throw Error('Zum Aktivieren sind Repository und Fine-grained Token erforderlich.');
  const next={...(sameRepo?config:{}),repo,token:credential||'',enabled,lastError:null};
  persist(next);
  running?.abort();
  if(!sameRepo||token)lastAttempt=0;
  return view();
 }
 async function submit(snapshot,controller){
  const ref=config.repo, key=config.token;
  const headers={authorization:'Bearer '+key,accept:'application/vnd.github+json',
   'x-github-api-version':'2022-11-28','user-agent':'BMW-AI-Pi','content-type':'application/json'};
  const api=(suffix,options={})=>request(API+ref+suffix,{...options,headers,redirect:'error',
   signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});
  const read=async (response, phase)=>{
   if(!response.ok)throw Error(phase+'_http_'+response.status);
   return response.json();
  };
  const repo=await read(await api(''),'repository');
  if(repo.private!==true||repo.visibility!=='private'||repo.full_name?.toLowerCase()!==ref.toLowerCase())
   throw Error('repository_not_private');
  const resource='/contents/'+REPORT_PATH;
  const current=await api(resource);
  let sha;
  if(current.status!==404){
   const file=await read(current,'read');
   if(file.type!=='file'||!(/^[a-f0-9]{40}$/.test(file.sha||'')))throw Error('unexpected_github_file');
   sha=file.sha;
   if(file.encoding==='base64'&&typeof file.content==='string'&&file.content.length<50000){
    try{
     const previous=JSON.parse(Buffer.from(file.content,'base64'));
     if(previous.fingerprint===snapshot.fingerprint)return;
    }catch(e){}
   }
  }
  if(controller.signal.aborted)return;
  const written=await api(resource,{method:'PUT',body:JSON.stringify({
   message:'Update BMW AI diagnostic status',
   content:Buffer.from(JSON.stringify(snapshot,null,2)+'\n').toString('base64'),
   ...(sha?{sha}:{}),
  })});
  if(!written.ok)throw Error('write_http_'+written.status);
 }
 async function tick(poll,transport,serverVersion){
  if(!config.enabled||!credentials()||running||(lastAttempt&&clock()-lastAttempt<MIN_INTERVAL))return;
  const snapshot=report(poll,transport,serverVersion,now());
  if(!snapshot||(!snapshot.problem&&!config.lastFingerprint)||snapshot.fingerprint===config.lastFingerprint)return;
  const controller=new AbortController();
  running=controller;lastAttempt=clock();
  try{
   persist({...config,lastAttemptAt:now()});
   await submit(snapshot,controller);
   if(!controller.signal.aborted)persist({...config,lastSuccessAt:now(),lastFingerprint:snapshot.fingerprint,lastError:null});
  }catch(e){
   if(!controller.signal.aborted){
    const code=/^(?:repository_not_private|unexpected_github_file|(?:repository|read|write)_http_[1-5]\d\d)$/.test(e.message)?e.message:'network_or_storage';
    try{persist({...config,lastError:code});}catch(e){}
   }
  }finally{running=null;}
 }
 return {view,configure,tick};
}
module.exports={publisher,report};
