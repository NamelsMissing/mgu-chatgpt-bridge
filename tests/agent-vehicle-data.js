'use strict';
// mgu-ai-agent 0.2.4: vehicle values only from the Vehicle Data app's file, never simulated.
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-vd-'));
process.env.MGU_AI_OAP_APPS=path.join(dir,'oap');process.env.MGU_AI_CONFIG=path.join(dir,'config.json');process.env.MGU_AI_DATA=path.join(dir,'data');
const agent=require('../native/mgu-ai-agent/agent.js');
fs.mkdirSync(path.join(dir,'oap'),{recursive:true});
assert.strictEqual(agent.vehicleData().status,'unavailable');
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
assert.match(agent.vehicleData().reason,/Unknown/,'newest file wins and must be ours');
fs.rmSync(path.join(dir,'oap','oap_12212'),{recursive:true});
write(12211,{schema:1,app:'vehicle_data',mileage:{km:99999999}});
assert.strictEqual(agent.vehicleData().mileageKm,null,'implausible value dropped');
assert.strictEqual(agent.vehicleData().status,'waiting');
fs.rmSync(dir,{recursive:true,force:true});
console.log('mgu-ai-agent vehicle data tests passed');
