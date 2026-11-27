'use strict';
// End to end: real Vehicle Data recorder (synthetic drive) -> packet files -> real companion agent
// -> real Pi server -> SQLite -> trip API. Covers acknowledgement, duplicates, settings push,
// Pi restart, privacy of state.json and the reset boundary.
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const http=require('node:http');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {VehicleSnapshot}=require('../apps/vehicle_data/vehicle_snapshot');
const T=require('../apps/vehicle_data/telemetry');
const {drive}=require('./fixtures/synthetic-drive');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'telemetry-pipeline-'));
const oap=path.join(dir,'oap'),app=path.join(oap,'oap_12211'),data=path.join(app,'data');
fs.mkdirSync(path.join(app,'source'),{recursive:true});
fs.mkdirSync(data);
fs.writeFileSync(path.join(app,'source','package.json'),JSON.stringify({name:'vehicle_data',version:'0.2.13'}));
const password='development-test-password',deviceToken='b'.repeat(64),config=path.join(dir,'agent.json');
fs.writeFileSync(config,JSON.stringify({enabled:true,token:deviceToken}));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function port(){const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const v=s.address().port;await new Promise(r=>s.close(r));return v;}
async function waitFor(address,endpoint,headers){
  for(let i=0;i<80;i++){try{const r=await fetch(address+endpoint,{headers});if(r.ok){await r.text();return;}}catch(e){}await sleep(50);}
  throw Error('Service did not start: '+endpoint);
}
const start=(file,env)=>spawn(process.execPath,[path.join(__dirname,'..',file)],{env:{...process.env,...env},stdio:['ignore','ignore','inherit']});
async function stop(child){if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'exit');}}

(async()=>{
  let agent,pi;
  const agentPort=await port(),piPort=await port(),origin='http://127.0.0.1:'+piPort,mgu='http://127.0.0.1:'+agentPort;
  const agentEnv={MGU_AI_PORT:String(agentPort),MGU_AI_CONFIG:config,MGU_AI_OAP_APPS:oap,MGU_AI_DATA:dir};
  const piEnv={PORT:String(piPort),HOST:'127.0.0.1',DATA_DIR:path.join(dir,'pi'),LOGIN_PASSWORD:password,MGU_BASE_URL:'http://localhost:'+agentPort,
    NODE_OPTIONS:'--dns-result-order=ipv4first',MGU_TOKEN:deviceToken};
  let token='';
  const api=async(endpoint,method='GET',body)=>{
    const r=await fetch(origin+'/api/v1'+endpoint,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body&&JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  // The drive happened two hours ago; the MGU recorded it while the Pi was unreachable.
  const T0=Date.now()-2*3600000,clock={t:T0-30000};
  const recorder=new T.TelemetryRecorder({dataDir:data,now:()=>clock.t});
  const feed=[];
  const facts=drive(T0,(iface,field,raw,t)=>feed.push([t,iface,field,raw]));
  feed.sort((a,b)=>a[0]-b[0]);
  let tick=Math.ceil(feed[0][0]/1000)*1000;
  for(const [t,iface,field,raw] of feed){while(tick<=t){clock.t=tick;recorder.tick();tick+=1000;}clock.t=t;recorder.ingest(iface,field,raw);}
  while(clock.t<facts.end+60000){clock.t+=1000;recorder.tick();}
  recorder.flush(true);
  const packetDir=path.join(data,'telemetry');
  const produced=fs.readdirSync(packetDir).filter(n=>T.PACKET_NAME.test(n));
  assert.ok(produced.length>=40,'packets buffered offline: '+produced.length);
  const spare=path.join(dir,'spare.json');
  fs.copyFileSync(path.join(packetDir,produced[3]),spare);
  const snapshot=new VehicleSnapshot({dir:data,version:'0.2.13'});
  snapshot.extra=()=>({recorder:recorder.status()});
  assert.ok(snapshot.flush(true));
  try{
    agent=start('native/mgu-ai-agent/agent.js',agentEnv);
    pi=start('pi-source/server.js',piEnv);
    await waitFor(mgu,'/v1/status',{authorization:'Bearer '+deviceToken});
    await waitFor(origin,'/health');
    token=(await api('/login','POST',{password})).body.token;

    // Agent endpoints: bounded list, strict acknowledgement.
    const listed=await(await fetch(mgu+'/v1/telemetry?max=5',{headers:{authorization:'Bearer '+deviceToken}})).json();
    assert.equal(listed.packets.length,5);assert.equal(listed.pending,produced.length);
    const unauth=await fetch(mgu+'/v1/telemetry');assert.equal(unauth.status,401);
    const badAck=await fetch(mgu+'/v1/telemetry/ack',{method:'POST',headers:{authorization:'Bearer '+deviceToken,'content-type':'application/json'},body:JSON.stringify({ids:['../../etc/passwd','x']})});
    assert.equal((await badAck.json()).deleted,0);

    // Pull: everything stored with measurement time, acknowledged and removed from the MGU.
    let view=(await api('/telemetry/pull','POST')).body;
    assert.equal(view.status.state,'ok',JSON.stringify(view.status));
    assert.equal(view.status.packets,produced.length);
    assert.equal(fs.readdirSync(packetDir).filter(n=>T.PACKET_NAME.test(n)).length,0,'acknowledged packets deleted on the MGU');
    assert.ok(view.database.samples>3000);
    assert.ok(view.database.oldestSample>=T0-80000&&view.database.oldestSample<=T0,'stored with measurement time, not receive time: '+(view.database.oldestSample-T0));
    let trips=(await api('/telemetry/trips')).body.trips;
    assert.equal(trips.length,1);
    const trip=trips[0],s=trip.summary;
    assert.equal(trip.status,'closed');assert.equal(trip.start_ts,T0);assert.equal(trip.end_reason,'parked');
    assert.ok(Math.abs(s.distanceKm-facts.distanceKm)<Math.max(0.6,facts.distanceKm*0.02),'distance '+s.distanceKm+' vs '+facts.distanceKm);
    assert.ok(Math.abs(s.maxSpeedKmh-facts.vmax)<0.5);
    assert.equal(s.oil.max,facts.maxOil);assert.ok(Math.abs(s.coolant.start-9)<2,'start = mean of the first 10 s bucket');
    assert.ok(s.oil.reached&&s.oil.reached.ms>0,'oil reached 80 °C');
    assert.ok(s.idleMs>60000,'warm-up idle and town stops count as idle');
    assert.ok(s.movingMs<s.durationMs);
    assert.equal(s.quality,'good');

    // Duplicate after a lost acknowledgement: stored once, deleted again.
    const samplesBefore=view.database.samples;
    fs.copyFileSync(spare,path.join(packetDir,produced[3]));
    view=(await api('/telemetry/pull','POST')).body;
    assert.equal(view.status.duplicates,1);assert.equal(view.database.samples,samplesBefore);
    assert.equal(fs.readdirSync(packetDir).filter(n=>T.PACKET_NAME.test(n)).length,0);

    // Trip detail, name, category, validation, series.
    const id=trip.id;
    assert.equal((await api('/telemetry/trips/'+id,'POST',{name:'Testfahrt',category:'Arbeitsweg'})).body.trip.name,'Testfahrt');
    assert.equal((await api('/telemetry/trips/'+id,'POST',{category:'Rennstrecke'})).status,400);
    assert.equal((await api('/telemetry/trips/t1-zzzzzz')).status,404);
    assert.equal((await api('/telemetry/trips/..%2f..')).status,404);
    const series=(await api('/telemetry/series?signal=speed&from='+T0+'&to='+(T0+1500000)+'&max=100')).body;
    assert.ok(series.series.speed.points.length<=100&&series.series.speed.points.length>50);
    assert.equal((await api('/telemetry/series?signal=evil&from=0&to=1')).status,400);
    assert.equal((await api('/telemetry/series?signals=gear&from=0&to=1')).status,400,'enums are no curves');
    // Phase 2: overview for the time filter and trip series for the warm-up chart.
    const ov=(await api('/telemetry/overview?from='+(T0-3600000)+'&to='+Date.now())).body;
    assert.equal(ov.trips.length,1);assert.equal(ov.trips[0].oilMax,facts.maxOil);
    assert.ok(ov.trips[0].speedBandsMs.reduce((a,b)=>a+b,0)>15*60000,'speed bands cover the moving time');
    assert.ok(ov.trips[0].speedBandsMs[3]>0,'motorway band 100-130 km/h');
    const warm=(await api('/telemetry/trips/'+trip.id+'/series?signals=coolant,oil&max=300')).body;
    assert.equal(warm.trip.id,trip.id);assert.ok(warm.series.oil.points.length>50&&warm.series.coolant.points.length>50);
    assert.equal(Math.max(...warm.series.oil.points.map(p=>p[4])),facts.maxOil);
    assert.equal((await api('/telemetry/trips/t1-zzzzzz/series?signals=oil')).status,404);

    // Settings go to Vehicle Data through the agent.
    view=(await api('/telemetry/settings','POST',{enabled:false,idleEndMin:15})).body;
    assert.equal(view.settings.enabled,false);
    assert.equal((await api('/telemetry/settings','POST',{idleEndMin:500})).status,400);
    await api('/telemetry/pull','POST');
    const pushed=JSON.parse(fs.readFileSync(path.join(data,T.CONFIG_FILE),'utf8'));
    assert.equal(pushed.enabled,false);assert.equal(pushed.idleEndMin,15);

    // Privacy: state.json holds settings and status, no samples, no trip times.
    const state=fs.readFileSync(path.join(dir,'pi','state.json'),'utf8');
    assert.ok(!state.includes(id),'trip ids stay in the telemetry database');
    assert.ok(!/"rows"|speedVehicle|"packetId"/.test(state),'no telemetry rows or packets in state.json');
    assert.ok(!state.includes(new Date(trip.start_ts).toISOString()),'no trip start time in state.json');

    // Pi restart: data persists.
    await stop(pi);
    pi=start('pi-source/server.js',piEnv);
    await waitFor(origin,'/health');
    token=(await api('/login','POST',{password})).body.token;
    trips=(await api('/telemetry/trips')).body.trips;
    assert.equal(trips.length,1);assert.equal(trips[0].name,'Testfahrt');

    // Delete needs confirmation; reset needs the phrase and leaves maintenance alone.
    assert.equal((await api('/telemetry/trips/'+id,'DELETE')).status,400);
    assert.equal((await api('/telemetry/reset','POST',{confirm:'ja'})).status,400);
    const mileage=(await api('/vehicle/mileage','POST',{km:150000,date:'2026-11-01'})).status;
    assert.equal(mileage,201);
    assert.equal((await api('/telemetry/reset','POST',{confirm:'STATISTIK LÖSCHEN'})).status,200);
    assert.equal((await api('/telemetry/trips')).body.trips.length,0);
    assert.ok(JSON.stringify((await api('/vehicle')).body).includes('150000'),'maintenance data untouched by reset');
    console.log('Telemetry pipeline: offline buffer, agent list/ack, Pi ingest with measurement time, trip summary, duplicate, settings push, restart, privacy and reset passed.');
  }finally{await stop(agent);await stop(pi);}
})().catch(e=>{console.error(e);process.exit(1);});
