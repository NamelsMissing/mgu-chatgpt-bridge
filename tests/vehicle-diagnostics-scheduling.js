'use strict';

const assert=require('node:assert/strict');
const DiagnosticQueue=require('../apps/vehicle_data/diagnostic_queue');
const {createReport}=require('../native/mgu-ai-agent/vehicle-capabilities');
const {decodeSecureMileage,decodeMileageSupreme}=require('../apps/vehicle_data/vehicle_snapshot');
const {Diag}=require('../kit/runtime/diag');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

(async()=>{
 const phases=[],order=[],q=new DiagnosticQueue(s=>phases.push(s),1000);
 let finishFirst;
 const first=q.run('dpf','dpf-1',()=>new Promise(resolve=>{order.push('dpf-1');finishFirst=resolve;}));
 const next=q.run('dpf','dpf-2',()=>order.push('dpf-2'));
 const scan=q.run('fault','fault-1',()=>order.push('fault-1'));
 assert.equal(q.run('fault','fault-1',()=>assert.fail('duplicate scan')),scan);
 await pause(0);finishFirst();
 await Promise.all([first,next,scan]);
 assert.deepEqual(order,['dpf-1','fault-1','dpf-2']);
 assert.ok(phases.some(s=>s.waiting.includes('fault')));

 const stuck=new DiagnosticQueue(()=>{},30);
 let release;
 const timed=stuck.run('dpf','native',()=>new Promise(resolve=>{release=resolve;}));
 await assert.rejects(timed,/Zeitlimit/);
 await assert.rejects(stuck.run('fault','second',()=>assert.fail('overlap')),/belegt/);
 release();await pause(0);
 await stuck.run('fault','after-release',()=>order.push('after-release'));
 assert.equal(order.pop(),'after-release');

 const transport=new Diag({}, {warn(){},info(){}});
 transport.send=async()=>{
  setImmediate(()=>{
   transport.emit('frame',{ecu:18,uds:[0x62,0x19,0x02,0]});
   transport.emit('frame',{ecu:18,uds:[0x59,0x02,0xFF]});
  });
  return 'NO_ERROR';
 };
 const result=await transport.functional(0x19,[2,12],{idleMs:5,maxMs:20});
 assert.deepEqual([...result],[[18,[0x59,0x02,0xFF]]]);

 const manifest={proxies:{'de.bmw.infrastructure.SecureMileage':{attributes:{mileage:'rs'}}}};
 const installed={'de.bmw.infrastructure.SecureMileage':{fields:{mileage:{getter:{id:1}}}}};
 const generator={interface:{generate(c,m){
  const iface=Object.keys(m.proxies)[0],field=Object.keys(m.proxies[iface].attributes)[0];
  if(field==='Range')throw Error('field Range cannot be read on this unit; FULL PRIVATE CATALOG');
  return {[iface]:{fields:{[field]:{getter:{id:1}}}}};
 }},acl:{generate(){}}};
 const rows=createReport({private:'never output'},generator,manifest,installed);
 const mileage=rows.find(r=>r.field==='mileage'),range=rows.find(r=>r.field==='Range');
 assert.equal(mileage.manifestSubscribe,true);
 assert.equal(mileage.installedGetter,true);
 assert.equal(mileage.installedSubscription,false);
 assert.equal(mileage.catalogGetter.supported,true);
 assert.equal(range.catalogGetter.reason,'getter_unavailable');
 assert.doesNotMatch(JSON.stringify(rows),/FULL PRIVATE CATALOG|never output/);
 assert.equal(createReport(null,null,manifest,installed)[0].catalogGetter.supported,null);
 assert.equal(decodeSecureMileage({currentMileage:'12345'}).reason,'unexpected_shape_or_type');
 assert.equal(decodeMileageSupreme({mileageSupreme:12345,qualifierMileageSupreme:'UNKNOWN'}).reason,'qualifier_unavailable');
 console.log('Vehicle diagnostics: priority, bounded wait, no overlapping UDS, capability projection and decode reasons passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
