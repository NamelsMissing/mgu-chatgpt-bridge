'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {once}=require('node:events');

const data=fs.mkdtempSync(path.join(os.tmpdir(),'bmw-ai-maintenance-'));
const file=path.join(data,'state.json'),password='test-only-maintenance-migration';
const read=()=>JSON.parse(fs.readFileSync(file));
const write=value=>fs.writeFileSync(file,JSON.stringify(value));
const day=offset=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
const plusMonths=(date,months)=>{
 const [y,m,d]=date.split('-').map(Number);
 return new Date(Date.UTC(y,m-1+months,Math.min(d,new Date(Date.UTC(y,m+months,0)).getUTCDate()))).toISOString().slice(0,10);
};
const date=day(-26),km=95747;
const service=(scope,label)=>({scope,label,status:'SERVICE_PERFORMED'});
const original={date,km,dealer:'12345',status:'SERVICE_PERFORMED',
 services:[service('OELSERVICE','Motoröl'),service('11','Code 11'),service('EINFAHRKONTROLLE','Einfahrkontrolle')]};
const brake={date,km,dealer:'12345',services:[service('BREMSFLUESSIGKEIT','Bremsflüssigkeit')]};
const coolant={date:day(-50),km:95000,services:[service('KUEHLFLUESSIGKEIT','Kühlflüssigkeit')]};
const oil={id:'oil',name:'Motoröl und Ölfilter',intervalKm:8000,intervalMonths:12,initialDefault:true};
const localId='9a32d425-c410-415a-abb3-5cc1aa1e5379';
const imported={id:localId,date,km,items:['oil'],title:'Code 11, Einfahrkontrolle',workshop:'Eigene Werkstatt',
 notes:'Aus der Servicehistorie des Fahrzeugs übernommen. Rechnung geprüft.',cost:129.90,
 createdAt:day(-25)+'T12:00:00Z',updatedAt:day(-13)+'T15:00:00Z'};
const extra={id:'5d35d897-a27d-4c7a-be6d-cbd9bd24a908',date,km,items:[],title:'Neue Wischer',
 notes:'Eigene Arbeit',cost:23};
const old={vehicle:{mileage:[],items:{oil},entries:{[localId]:imported,[extra.id]:extra},
 live:{cbs:[{scope:'OELSERVICE',label:'Motoröl',remainingKm:4000}],serviceHistory:{status:'E_OK',sets:[original,original,brake,coolant]}}},
 mguConnection:{url:'http://127.0.0.1:1',token:'a'.repeat(64)}};
let pi,api,base;
async function stop(){
 if(!pi||pi.exitCode!==null)return;
 pi.kill();
 await once(pi,'exit');
}
async function start(serverFile=path.join(__dirname,'../server.js')){
 const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
 const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 base='http://127.0.0.1:'+port;
 let output='';
 pi=spawn(process.execPath,[serverFile],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',
  DATA_DIR:data,LOGIN_PASSWORD:password,TAILSCALE_BIN:path.join(data,'no-tailscale')},stdio:['ignore','pipe','pipe']});
 pi.stdout.on('data',chunk=>output+=chunk);
 pi.stderr.on('data',chunk=>output+=chunk);
 for(let n=0;n<100;n++){
  const ready=await fetch(base+'/health').catch(()=>null);
  if(ready?.ok)break;
  if(n===99||pi.exitCode!==null)throw Error('Pi startup failed: '+output);
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 const login=await fetch(base+'/api/v1/login',{method:'POST',body:JSON.stringify({password})});
 const {token}=await login.json();
 assert.ok(token);
 api=async(method,route,value)=>{
  const result=await fetch(base+'/api/v1'+route,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},
   body:value===undefined?undefined:JSON.stringify(value)});
  return {status:result.status,data:await result.json()};
 };
}
(async()=>{
 write(old);
 await start();
 const initial=await api('GET','/vehicle'),v=initial.data;
 assert.equal(initial.status,200);
 assert.equal(v.maintenance.profile,'legacy-plan');
 assert.equal(v.items.length,10);
 assert.deepEqual(Object.fromEntries(v.items.map(i=>[i.id,[i.intervalKm,i.intervalMonths]])),{
  oil:[8000,12],microfilter:[30000,24],check:[60000,48],airFilter:[60000,48],fuelFilter:[60000,48],
  brakeFluid:[0,24],coolant:[0,36],inspection:[0,24],
  automaticOil:[80000,72],rearDifferentialOil:[80000,72],
 });
 const item=key=>v.due.find(row=>row.key===key);
 assert.equal(item('microfilter').status,'unknown');
 assert.equal(item('airFilter').lastDone.date,date);
 assert.equal(item('brakeFluid').dueDate,plusMonths(date,24));
 assert.equal(item('coolant').dueDate,plusMonths(coolant.date,36));
 assert.equal(item('oil').lastDone.date,date);
 assert.equal(v.bmwNextService.byDistance.remainingKm,4000);
 assert.equal(v.maintenanceOverview.next.byDate.id,'oil');
 assert.equal(v.maintenanceOverview.unknownCount,5);
 assert.equal(v.history.length,4,'duplicate BMW records and old import collapse, distinct work remains');
 const merged=v.history.find(row=>row.bmw?.services.length===3);
 assert.equal(merged.localEntries[0].id,localId);
 assert.equal(merged.localEntries[0].cost,129.90);
 assert.match(merged.localEntries[0].notes,/Rechnung geprüft/);
 assert.ok(merged.localEntries[0].bmwRef);
 assert.ok(v.history.some(row=>row.localEntries.some(entry=>entry.id===extra.id)));
 assert.equal(read().vehicle.live.serviceHistory.sets.length,4,'original cached rows preserved');
 assert.equal((await api('POST','/vehicle/import-history',{date,km})).status,400,'ambiguous BMW records require explicit reference');
 const brakeRef=v.live.serviceHistory.sets.find(set=>set.services[0].scope==='BREMSFLUESSIGKEIT').reference;
 const newImport=await api('POST','/vehicle/import-history',{date,km,reference:brakeRef});
 assert.equal(newImport.status,200);
 assert.equal(newImport.data.history.find(row=>row.reference===brakeRef).localEntries[0].bmwRef,brakeRef);
 const edited=await api('POST','/vehicle/entries',{...imported,notes:'Komplett ersetzt',cost:150,bmwRef:'IGNORED'});
 assert.equal(edited.data.history.find(row=>row.reference===merged.reference).localEntries[0].notes,'Komplett ersetzt');
 assert.equal(edited.data.history.find(row=>row.reference===merged.reference).localEntries[0].bmwRef,merged.reference);
 const overdue=await api('POST','/vehicle/items',{id:'oil',name:oil.name,intervalMonths:12,intervalKm:8000,dueDate:day(-1)});
 assert.equal(overdue.data.maintenanceOverview.dueCount,1,'CBS and own plan count once, own overdue still counts');
 assert.equal(overdue.data.bmwNextService.byDistance.remainingKm,4000);
 await api('POST','/monitor/poll');
 assert.equal((await api('GET','/vehicle')).data.poll.connection,'unreachable');
 await stop();

 await start();
 let saved=(await api('GET','/vehicle')).data;
 assert.equal(saved.items.length,10);
 assert.equal(saved.history.length,4);
 assert.equal(saved.entries.find(entry=>entry.id===localId).cost,150);
 assert.equal(saved.items.find(item=>item.id==='oil').intervalKm,8000);
 await stop();

 const previous=read();
 write({...previous,mguConnection:{url:'http://127.0.0.1:2',token:'b'.repeat(64)}});
 await start();
 saved=(await api('GET','/vehicle')).data;
 assert.equal(saved.items.length,1,'new MGU gets no migrated G21 plan');
 assert.equal(saved.history.length,0);
 await stop();
 write({...read(),mguConnection:old.mguConnection});
 await start();
 assert.equal((await api('GET','/vehicle')).data.history.length,4,'previous book restored');
 await stop();

 write({vehicle:{items:{oil,existing:{id:'existing',name:'Pollenfilter',intervalKm:18000,intervalMonths:18}},
  entries:{},mileage:[],maintenance:{registration:day(-700)}}});
 await start();
 saved=(await api('GET','/vehicle')).data;
 assert.equal(saved.items.length,10);
 assert.equal(saved.items.find(item=>item.id==='existing').intervalKm,18000);
 assert.equal(saved.due.find(item=>item.key==='brakeFluid').dueDate,plusMonths(day(-700),36));
 assert.equal(saved.due.find(item=>item.key==='inspection').dueDate,plusMonths(day(-700),36));
 assert.equal(saved.due.find(item=>item.key==='coolant').dueDate,plusMonths(day(-700),36));
 assert.equal(saved.due.find(item=>item.key==='coolant').basis,'registration');
 await stop();


 // Known work, timed-only deadlines, and large-service estimation from cached history.
 const performed=(on,km,...services)=>({date:on,km,status:'SERVICE_PERFORMED',services});
 const older=day(-500),majorDate=day(-200);
 const initialOil=performed(older,60000,service('OELSERVICE','Motoröl'));
 const secondOil=performed(majorDate,87921,service('OELSERVICE','Motoröl'));
 const local=(id,on,title,notes='')=>({id,date:on,km:null,items:[],title,notes});
 const records=[
  initialOil,secondOil,secondOil,
  performed(day(-100),92500,service('201','Code 201'),service('202','Code 202')),
  performed(day(-70),94000,service('KUEHLFLUESSIGKEIT','Kühlmittel nachgefüllt')),
  performed(day(-60),95000,{scope:'FREITEXT',label:'Motorluftfilter',status:'SERVICE_INCOMPLETE'}),
  performed(day(-55),95400,{...service('203','Code 203'),code:203}),
 ];
 const savedBook={items:{oil},entries:{
  ownOil:local('ownOil',day(-15),'Ölwechsel'),
  fluid:local('fluid',day(-30),'Kühlmittel-Füllstand kontrolliert'),
  hu:local('hu',day(-90),'HU bestanden'),
 },mileage:[],live:{cbs:[{scope:'HU_HAUPTUNTERSUCHUNG',label:'Hauptuntersuchung',dueDate:day(250)}],
  serviceHistory:{status:'E_OK',sets:records}}};
 write({vehicle:savedBook});
 await start();
 saved=(await api('GET','/vehicle')).data;
 const find=key=>saved.due.find(item=>item.key===key);
 for(const key of ['airFilter','fuelFilter']){
  assert.equal(find(key).dueDate,plusMonths(majorDate,48));
  assert.equal(find(key).dueKm,147921);
  assert.equal(find(key).basis,'cycle');
  assert.equal(find(key).lastDone,null);
 }
 assert.equal(find('coolant').dueDate,null);
 assert.equal(find('inspection').dueDate,plusMonths(day(-90),24));
 assert.equal(find('inspection').basis,'own');
 assert.equal(saved.bmwNextService.byDate.dueDate,day(250));
 assert.equal(find('oil').intervalKm,8000);
 assert.equal(find('check').dueDate,null,'unknown ServiceHistory codes cannot confirm a service');
 assert.ok(saved.history.some(row=>row.bmw?.services.some(work=>work.code===203&&work.label==='Code 203')));
 const reference=await api('GET','/service-reference');
 assert.ok(reference.data.observations.some(row=>row.code===201&&row.status==='unknown'));
 const importedReference=await api('POST','/service-reference',{schema:1,rows:[{
  namespace:'servicehistory.serviceText',code:'0xCB',original:'TEST_CHECK',de:'Fahrzeug-Check',work:'check',
  interface:'ServiceHistory.readServiceHistory',source:'Nur Testfixture',version:'1',verification:'verified',
  description:'Synthetische Zuordnung für den Importtest, keine BMW-Referenz.'
 }]});
 assert.equal(importedReference.status,200);
 saved=(await api('GET','/vehicle')).data;
 assert.equal(find('check').dueDate,plusMonths(day(-55),48));
 assert.ok(saved.history.some(row=>row.bmw?.services.some(work=>work.code===203&&work.label==='Fahrzeug-Check')));
 assert.ok(saved.history.some(row=>row.bmw?.services.some(work=>work.label==='Code 201')));
 await stop();

 const documented=read();
 documented.vehicle.live.serviceHistory.sets.push(
  performed(day(-40),null,service('FREITEXT','Motorluftfilter erneuert')),
  performed(day(-35),null,service('FREITEXT','Dieselfilter gewechselt')));
 documented.vehicle.entries.realCoolant=local('realCoolant',day(-22),'Rechnung','Frostschutzmittel gewechselt');
 write(documented);
 await start();
 saved=(await api('GET','/vehicle')).data;
 assert.equal(find('airFilter').basis,'BMW');
 assert.equal(find('airFilter').dueDate,plusMonths(day(-40),48));
 assert.equal(find('airFilter').dueKm,null);
 assert.equal(find('fuelFilter').basis,'BMW');
 assert.equal(find('fuelFilter').dueDate,plusMonths(day(-35),48));
 assert.equal(find('coolant').dueDate,plusMonths(day(-22),36));
 assert.equal(find('coolant').basis,'own');
 await stop();

 // Existing v1 G21 book upgrades without replacing an individual gearbox interval.
 const serviceDate=day(-41),rearDate=day(-61);
 const gearEntry={id:'documented-gear',date:serviceDate,km:91000,items:[],title:'Rechnung',notes:'Automatikgetriebeöl gewechselt'};
 const rearOriginal=performed(rearDate,89000,service('FREITEXT','Hinterachsgetriebeöl erneuert'));
 const otherOils=performed(day(-3),95000,
  {...service('GETRIEBEOEL_HAUPTGETRIEBE','Getriebeöl'),code:35},
  {...service('9','QMV-H-Öl'),code:9},{...service('18','Kühlflüssigkeit'),code:18});
 write({vehicle:{maintenanceMigration:1,items:{oil,gear:{id:'gear',name:'ATF-Wechsel',intervalKm:70000,intervalMonths:60}},
  maintenance:{profile:'g21-diesel'},entries:{[gearEntry.id]:gearEntry},mileage:[],
  live:{cbs:[{scope:'GETRIEBEOEL_HAUPTGETRIEBE',label:'Hauptgetriebeöl',dueDate:day(1500)}],
   serviceHistory:{status:'E_OK',sets:[rearOriginal,otherOils]}}}});
 await start();
 saved=(await api('GET','/vehicle')).data;
 assert.equal(find('automaticOil').dueKm,161000);
 assert.equal(find('automaticOil').dueDate,plusMonths(serviceDate,60));
 assert.equal(find('automaticOil').basis,'own');
 assert.equal(find('rearDifferentialOil').dueKm,169000);
 assert.equal(find('rearDifferentialOil').dueDate,plusMonths(rearDate,72));
 assert.equal(find('rearDifferentialOil').basis,'BMW');
 assert.equal(find('coolant'),undefined,'migration v2 adds only newly introduced items');
 assert.equal(saved.maintenanceOverview.cbsKeys.GETRIEBEOEL_HAUPTGETRIEBE,'automaticOil');
 const oilTask={name:'Verteilergetriebeöl',intervalKm:65000,intervalMonths:60};
 assert.equal((await api('POST','/vehicle/items',oilTask)).status,400);
 const vehiclePlan={profile:'g21-diesel',equipment:{automaticTransmission:true,rearDifferential:false,transferCase:true}};
 assert.equal((await api('POST','/vehicle/maintenance',vehiclePlan)).status,200);
 assert.equal((await api('POST','/vehicle/items',oilTask)).status,200);
 const deactivate=await api('POST','/vehicle/maintenance',{...vehiclePlan,equipment:{...vehiclePlan.equipment,transferCase:false}});
 assert.ok(deactivate.data.items.some(item=>item.name===oilTask.name));
 assert.ok(!deactivate.data.due.some(item=>item.key==='transferCaseOil'||item.key==='rearDifferentialOil'));
 const sameState=await api('GET','/service-reference');
 for(const code of [9,18,35])assert.ok(sameState.data.observations.some(row=>row.code===code&&row.status==='external'));
 await stop();

 // Restores the existing rear axle row on reactivation, without duplication.
 await start();
 const restored=await api('POST','/vehicle/maintenance',{...vehiclePlan,equipment:{...vehiclePlan.equipment,rearDifferential:true}});
 assert.equal(restored.data.items.filter(item=>item.planKey==='rearDifferentialOil').length,1);
 assert.equal(restored.data.due.find(item=>item.key==='rearDifferentialOil').lastDone.date,rearDate);
 await stop();
 write({vehicle:{items:{oil},entries:{},mileage:[],maintenance:{profile:'custom'}}});
 await start();
 saved=(await api('GET','/vehicle')).data;
 assert.equal(saved.items.length,1);
 assert.equal(saved.maintenance.profile,'custom');
 await stop();

 // 0.10.10 on-disk shape: numeric original codes with the former Vehicle Data scope/label.
 // The supplied anonymised history is treated as completed here solely for this fixture.
 const historicScopes={1:'OELSERVICE',3:'BREMSFLUESSIGKEIT',4:'MIKROFILTER',21:'EINFAHRKONTROLLE',100:'SICHTPRUEFUNG_ADAPTIV'};
 const exampleHistory=[
  ['2026-10-31',95747,[1,11,21]],['2026-07-31',87921,[1,11,3,4,100]],
  ['2026-04-12',79780,[1,4,11,12,100]],['2025-11-29',69512,[1,11,4,100]],
  ['2024-07-11',49324,[1,3,4,12]],
 ].map(([date,km,codes])=>performed(date,km,...codes.map(code=>({
  ...service(historicScopes[code]||String(code),'Code '+code),code
 }))));
 exampleHistory.push(performed('2026-11-01',96000,
  {code:3,scope:'3',label:'Code 3',status:'SERVICE_INCOMPLETE'},service('254','Code 254'),service('5','Code 5')));
 const savedV01010={vehicle:{maintenanceMigration:1,maintenance:{profile:'g21-diesel'},
  items:{oil:{...oil},brakeFluid:{id:'brakeFluid',name:'Bremsflüssigkeit',intervalMonths:24},
   microfilter:{id:'microfilter',name:'Mikrofilter',intervalMonths:24,intervalKm:30000},
   check:{id:'check',name:'Fahrzeug-Check',intervalMonths:48,intervalKm:60000},
   airFilter:{id:'airFilter',name:'Motorluftfilter',intervalMonths:48,intervalKm:60000},
   fuelFilter:{id:'fuelFilter',name:'Kraftstofffilter Diesel',intervalMonths:48,intervalKm:60000}},
  mileage:[],entries:{},live:{cbs:[],serviceHistory:{status:'E_OK',sets:exampleHistory}}},
  mguConnection:{url:'http://127.0.0.1:1',token:'c'.repeat(64)}};
 // 0.10.10 used the legacy numeric map for these four known works.
 const priorDue={oil:['2027-10-31',103747],brakeFluid:['2028-07-31',null],
   microfilter:['2028-07-31',117921],check:['2030-07-31',147921]};
 const legacyServer=process.env.BMW_AI_LEGACY_TEST_SERVER;
 if(legacyServer){
  write(savedV01010);
  await start(legacyServer);
  saved=(await api('GET','/vehicle')).data;
  for(const [key,[date,km]] of Object.entries(priorDue)){
   assert.equal(find(key).dueDate,date,'0.10.10 '+key);
   assert.equal(find(key).dueKm,km,'0.10.10 '+key);
  }
  await stop();
 }
 const expected={...priorDue,airFilter:['2030-10-31',155747],fuelFilter:['2030-04-12',139780]};
 const referenceFile=path.join(data,'service-reference.sqlite');
 for(const dbState of ['missing','empty','unreadable']){
  fs.rmSync(referenceFile,{force:true});
  if(dbState==='empty')fs.writeFileSync(referenceFile,'');
  if(dbState==='unreadable')fs.writeFileSync(referenceFile,'unknown data, preserved');
  write(savedV01010);
  await start();
  await api('POST','/monitor/poll');
  saved=(await api('GET','/vehicle')).data;
  for(const [key,[date,km]] of Object.entries(expected)){
   assert.equal(find(key).dueDate,date,dbState+' '+key);
   assert.equal(find(key).dueKm,km,dbState+' '+key);
  }
  assert.equal(saved.poll.connection,'unreachable');
  assert.equal(find('oil').intervalKm,8000);
  assert.ok(saved.history.some(row=>row.bmw?.services.some(work=>work.code===254&&work.referenceStatus==='unknown')));
  assert.ok(saved.history.some(row=>row.bmw?.services.some(work=>work.code===5&&work.referenceStatus==='ambiguous')));
  assert.equal(read().vehicle.live.serviceHistory.sets.length,exampleHistory.length);
  if(dbState==='unreadable'){
   assert.equal(fs.readFileSync(referenceFile,'utf8'),'unknown data, preserved');
   assert.ok((await api('GET','/service-reference')).data.error);
  }
  await stop();
 }
 console.log('Pi maintenance migration: legacy plan, alias, offline restart, pairing isolation, service references and due counts passed.');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
 await stop();
 fs.rmSync(data,{recursive:true,force:true});
});
