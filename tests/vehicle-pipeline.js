'use strict';
// Exercise the actual Agent and Pi processes over HTTP. The snapshot is a fixture,
// because the BMW SOME/IP and TASU providers run on the head unit.
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const http=require('node:http');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {VehicleSnapshot}=require('../apps/vehicle_data/vehicle_snapshot');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vehicle-pipeline-'));
const oap=path.join(dir,'oap'),app=path.join(oap,'oap_12211'),data=path.join(app,'data');
fs.mkdirSync(path.join(app,'source'),{recursive:true});
fs.mkdirSync(data);
fs.writeFileSync(path.join(app,'source','package.json'),JSON.stringify({name:'vehicle_data'}));
const password='development-test-password';
const deviceToken='a'.repeat(64),config=path.join(dir,'agent.json');
fs.writeFileSync(config,JSON.stringify({enabled:true,token:deviceToken}));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function port(){
 const server=http.createServer();
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const value=server.address().port;
 await new Promise(resolve=>server.close(resolve));
 return value;
}
async function waitFor(address,endpoint,headers){
 for(let i=0;i<50;i++){
  try{const r=await fetch(address+endpoint,{headers});if(r.ok){await r.text();return;}}catch(e){}
  await sleep(50);
 }
 throw Error('Service did not start: '+endpoint);
}
function start(file,env){
 return spawn(process.execPath,[path.join(__dirname,'..',file)],{env:{...process.env,...env},stdio:['ignore','ignore','inherit']});
}
async function stop(child){
 if(child&&child.exitCode===null&&child.signalCode===null){
  child.kill('SIGTERM');await once(child,'exit');
 }
}
(async()=>{
 let agent,pi;
 const agentPort=await port(),piPort=await port();
 const mgu='http://127.0.0.1:'+agentPort,origin='http://127.0.0.1:'+piPort;
 const agentEnv={MGU_AI_PORT:String(agentPort),MGU_AI_CONFIG:config,MGU_AI_OAP_APPS:oap,MGU_AI_DATA:dir};
 const piEnv={PORT:String(piPort),HOST:'127.0.0.1',DATA_DIR:path.join(dir,'pi'),LOGIN_PASSWORD:password,MGU_BASE_URL:'http://localhost:'+agentPort,NODE_OPTIONS:'--dns-result-order=ipv4first',MGU_TOKEN:deviceToken};
 let token='';
 async function api(endpoint,method='GET',data){
  const response=await fetch(origin+'/api/v1'+endpoint,{
   method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},
   body:data&&JSON.stringify(data)
  });
  return {status:response.status,body:await response.json()};
 }
 try{
  agent=start('native/mgu-ai-agent/agent.js',agentEnv);
  pi=start('pi-source/server.js',piEnv);
  await waitFor(mgu,'/v1/status',{authorization:'Bearer '+deviceToken});
  await waitFor(origin,'/health');
  token=(await api('/login','POST',{password})).body.token;
  assert.equal((await api('/faults/read','POST')).status,503);

  const snapshot=new VehicleSnapshot({dir:data,version:'fixture'});
  snapshot.range({mileageKilometre:123456});
  snapshot.stage('VehicleInformation.Range','manifestRead',true);
  snapshot.stage('VehicleInformation.Range','getter','ok');
  snapshot.receivedValue('VehicleInformation.Range',{mileageKilometre:123456,vin:'sensitive-example',opaque:'not exported'},1);
  const cbs=[{cBSDataServiceWithSymbolID:{cBSDataService:{cBSIdentifier:'OELSERVICE',
   cBSServcieName:'Motoröl',yearCBSDisplay:2027,monthCBSDisplay:5}}}];
  snapshot.cbsList(cbs);
  snapshot.receivedValue('KombiInterface_2.cbsDataServiceList',cbs,1);
  snapshot.extra=()=>({checkControl:{listAt:new Date().toISOString(),source:'CheckControlMaster.basicList',active:[{id:22,active:true,text:'Testmeldung',color:'YELLOW',ecu:0x40}],events:[],receipts:{'CheckControlMaster.basicList':{origin:'get',shape:'array',length:1,valid:1,rejected:0,complete:true,authoritative:true}}}});
  assert.ok(snapshot.flush(true));
  await api('/monitor/poll','POST');
  let v=(await api('/vehicle')).body.live;
  assert.equal(v.mileageKm,123456);assert.equal(v.mileageSource,'VehicleInformation.Range');assert.equal(v.stale,false);
  let measuredAt=v.mileageAt;
  assert.equal(v.cbs[0].source,'KombiInterface_2.cbsDataServiceList');
  assert.equal(v.cbs[0].dueMonth,'2027-05');
  assert.equal((await api('/faults')).body.checkControl.active[0].text,'Testmeldung');
  const diag=(await api('/vehicle/diagnostics')).body;
  assert.equal(diag.poll.stages['VehicleInformation.Range'].initialGetter,'ok');
  assert.equal(diag.poll.stages['VehicleInformation.Range'].decoded,true);
  assert.ok(diag.poll.transfer.snapshotAt);
  assert.ok(diag.poll.transfer.agentForwardedAt);
  assert.ok(diag.poll.transfer.piPersistedAt);
  assert.equal(diag.poll.versions.agent,'0.2.13');
  assert.equal(diag.checkControl.active[0].color,'YELLOW');
  assert.equal(diag.checkControl.receipts['CheckControlMaster.basicList'].authoritative,true);
  assert.equal(diag.poll.versions.vehicleDataInstalled.length,0,'fixture package has no version metadata');
  const checks=(await api('/vehicle/diagnostics?capabilities=1')).body.capabilities;
  assert.equal(checks.schema,1);
  assert.ok(checks.rows.some(row=>row.field==='Range'));
  assert.ok(checks.rows.every(row=>!row.catalogGetter.supported),'local fixture does not verify BMW capabilities');
  assert.equal(diag.poll.received['VehicleInformation.Range'].count,1);
  assert.match(JSON.stringify(diag.samples),/123456/);
  assert.doesNotMatch(JSON.stringify(diag.samples),/sensitive-example|not exported|vin/i);

  await stop(agent);
  await api('/monitor/poll','POST');
  const offline=(await api('/vehicle')).body;
  assert.equal(offline.poll.connection,'unreachable');
  assert.match(offline.poll.error,/möglicherweise ausgeschaltet oder im Standby/);
  assert.equal(offline.live.stale,true);
  assert.equal(offline.live.cbsStale,true);
  agent=start('native/mgu-ai-agent/agent.js',agentEnv);
  await waitFor(mgu,'/v1/status',{authorization:'Bearer '+deviceToken});
  await api('/monitor/poll','POST');
  const reconnected=(await api('/vehicle')).body;
  assert.equal(reconnected.poll.connection,'reachable');
  assert.equal(reconnected.live.stale,true);
  assert.equal(reconnected.live.cbsStale,true);
  snapshot.range({mileageKilometre:123456});
  snapshot.receivedValue('KombiInterface_2.cbsDataServiceList',cbs,1);
  assert.ok(snapshot.flush(true));
  await api('/monitor/poll','POST');
  v=(await api('/vehicle')).body.live;
  assert.equal(v.stale,false);
  assert.equal(v.cbsStale,false);
  assert.notEqual(v.mileageAt,measuredAt);
  measuredAt=v.mileageAt;

  const favorite=(await api('/mgu/favorites','POST',{name:'Test',path:'/tmp'})).body.favorites[0];
  await stop(pi);
  pi=start('pi-source/server.js',piEnv);
  await waitFor(origin,'/health');
  v=(await api('/vehicle')).body.live;
  assert.equal(v.mileageAt,measuredAt);assert.equal(v.stale,true);
  assert.deepEqual((await api('/mgu/favorites')).body.favorites,[favorite]);
  await api('/monitor/poll','POST');
  assert.equal((await api('/vehicle')).body.live.stale,false);

  snapshot.range({mileageKilometre:0});
  assert.ok(snapshot.flush(true));
  await api('/monitor/poll','POST');
  v=(await api('/vehicle')).body.live;
  assert.equal(v.mileageKm,123456);assert.equal(v.mileageAt,measuredAt);assert.equal(v.stale,true);
  assert.equal((await api('/vehicle/mileage','POST',{km:123999})).status,201);
  const workDate=new Date(Date.now()-86400000).toISOString().slice(0,10);
  assert.equal((await api('/vehicle/entries','POST',{date:workDate,km:120000,items:['oil']})).status,200);
  snapshot.diagnosticMileage(123457,{source:'KOMBI 0xD122',ecu:0x60,did:0xD122});
  const previousExtra=snapshot.extra;
  snapshot.extra=()=>({...previousExtra(),tyres:{at:new Date().toISOString(),source:'RDC 0x29',
   wheels:[{position:'FRONT_LEFT',pressureBar:2.425,targetBar:2.275,temperatureC:15}]}});
  assert.ok(snapshot.flush(true));
  await api('/monitor/poll','POST');
  const latest=(await api('/vehicle')).body;
  assert.equal(latest.live.mileageKm,123457);
  assert.equal(latest.live.mileageSource,'KOMBI 0xD122');
  assert.equal(latest.live.mileageEcu,0x60);
  assert.equal(latest.live.mileageDid,0xD122);
  assert.equal(latest.mileage.km,123457);
  assert.equal(latest.mileageConflict.manualKm,123999);
  assert.equal(latest.due.find(row=>row.id==='oil').kmLeft,4543);
  assert.equal(latest.due.find(row=>row.id==='oil').intervalMonths,12);
  assert.equal(latest.live.stale,false);
  assert.equal(latest.tyres.source,'RDC 0x29');
  assert.equal(latest.tyres.wheels[0].temp,15);
  assert.equal(latest.tyres.stale,false);
  console.log('Vehicle pipeline: actual Agent and Pi HTTP, 503, timestamps, process restarts, reconnect and persistence passed.');
 }finally{
  await Promise.all([stop(agent),stop(pi)]);
  fs.rmSync(dir,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
