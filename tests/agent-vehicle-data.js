'use strict';
// mgu-ai-agent 0.2.4: vehicle values only from the Vehicle Data app's file, never simulated.
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-vd-'));
process.env.MGU_AI_OAP_APPS=path.join(dir,'oap');process.env.MGU_AI_CONFIG=path.join(dir,'config.json');process.env.MGU_AI_DATA=path.join(dir,'data');
const agent=require('../native/mgu-ai-agent/agent.js');
fs.mkdirSync(path.join(dir,'oap'),{recursive:true});
assert.strictEqual(agent.vehicleData().status,'unavailable');
assert.strictEqual(agent.vehicleData().appState,'not_detected');
const manifestDir=path.join(dir,'oap','oap_12211','source');
fs.mkdirSync(manifestDir,{recursive:true});
fs.writeFileSync(path.join(manifestDir,'package.json'),JSON.stringify({name:'vehicle_data'}));
assert.strictEqual(agent.vehicleData().appState,'no_snapshot');
agent.readFaultMemory(r=>assert.strictEqual(r.status,503));
const write=(uid,doc)=>{const d=path.join(dir,'oap','oap_'+uid,'data');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'bmw-vehicle-data.json'),typeof doc==='string'?doc:JSON.stringify(doc));};
write(12210,'{broken');
assert.match(agent.vehicleData().reason,/unreadable/);
write(12211,{schema:1,app:'vehicle_data',version:'0.1.0',writtenAt:'2026-11-17T10:00:00Z',mileage:{km:143350,source:'SecureMileage',at:'2026-11-17T09:59:00Z'},
 cbs:[{scope:'OELSERVICE',label:'Motoröl',remainingKm:850,dueDate:'2027-04-01',raw:{x:1}}],serviceHistory:{status:'E_OK',readAt:'2026-11-17T10:00:00Z',sets:[{date:'2026-04-01',km:136200,services:[{scope:'OELSERVICE',label:'Motoröl'}]}]},signals:{SecureMileage:{available:true}}});
const v=agent.vehicleData();
assert.strictEqual(v.status,'ok');assert.strictEqual(v.mileageKm,143350);assert.strictEqual(v.unverified,true);
assert.deepStrictEqual(v.cbs[0],{scope:'OELSERVICE',label:'Motoröl',remainingKm:850,dueDate:'2027-04-01',status:undefined,at:undefined},'raw values are not passed on');
assert.strictEqual(v.serviceHistory.sets[0].km,136200);
write(12212,{schema:1,app:'other',mileage:{km:5}});
const later=new Date(Date.now()+5000);fs.utimesSync(path.join(dir,'oap','oap_12212','data','bmw-vehicle-data.json'),later,later);
assert.equal(agent.vehicleData().mileageKm,143350,'invalid newer snapshot must not hide valid vehicle data');
fs.rmSync(path.join(dir,'oap','oap_12212'),{recursive:true});
write(12211,{schema:1,app:'vehicle_data',mileage:{km:99999999}});
assert.strictEqual(agent.vehicleData().mileageKm,null,'implausible value dropped');
assert.strictEqual(agent.vehicleData().status,'waiting');
write(12211,{schema:1,app:'vehicle_data',heartbeatAt:new Date(Date.now()-120000).toISOString()});
assert.strictEqual(agent.vehicleData().appState,'stale');
agent.readFaultMemory(r=>{assert.strictEqual(r.status,503);assert.strictEqual(r.body.code,'stale');});
// New data passes through; fault-memory request goes to the app's data directory.
write(12211,{schema:1,app:'vehicle_data',mileage:{km:143400},heartbeatAt:new Date().toISOString(),checkControl:{active:[{id:220,text:'Kühlmittelstand zu niedrig',ecu:64}],events:[]},
 tyres:{wheels:[{position:'FRONT_LEFT',pressureBar:2.45,targetBar:2.5,temperatureC:18,battery:'OK',rawPressure:2450}]},dpf:{soot:12.3},faultMemory:{requestId:'start',dtcs:[],ecus:[]}});
const v2=agent.vehicleData();
assert.strictEqual(v2.appState,'running');
assert.strictEqual(v2.checkControl.active[0].text,'Kühlmittelstand zu niedrig');assert.strictEqual(v2.tyres.wheels[0].rawPressure,undefined);assert.strictEqual(v2.dpf.soot,12.3);
agent.readFaultMemory(r=>{
 assert.strictEqual(r.status,200);assert.strictEqual(r.body.faultMemory.dtcs[0].code,'480A12');
 fs.rmSync(dir,{recursive:true,force:true});
 console.log('mgu-ai-agent vehicle data tests passed');
});
agent.readFaultMemory(r=>assert.strictEqual(r.status,409));
setTimeout(()=>{
 const req=JSON.parse(fs.readFileSync(path.join(dir,'oap','oap_12211','data','bmw-vehicle-request.json'),'utf8'));
 assert.strictEqual(req.type,'faultMemory');
 write(12211,{schema:1,app:'vehicle_data',mileage:{km:143400},faultMemory:{requestId:req.id,readAt:'x',error:null,ecus:[{ecu:18,ok:true,count:1}],dtcs:[{ecu:18,code:'480A12',status:9}]}});
},1500);
