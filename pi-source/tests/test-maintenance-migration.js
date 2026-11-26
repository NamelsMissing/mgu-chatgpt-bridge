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
async function start(){
 const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
 const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 base='http://127.0.0.1:'+port;
 let output='';
 pi=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',
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
 assert.equal(v.items.length,8);
 assert.deepEqual(Object.fromEntries(v.items.map(i=>[i.id,[i.intervalKm,i.intervalMonths]])),{
  oil:[8000,12],microfilter:[30000,24],check:[60000,48],airFilter:[60000,48],fuelFilter:[60000,48],
  brakeFluid:[0,24],coolant:[0,36],inspection:[0,24],
 });
 const item=key=>v.due.find(row=>row.key===key);
 assert.equal(item('microfilter').status,'unknown');
 assert.equal(item('airFilter').lastDone,null);
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
 assert.equal(saved.items.length,8);
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
 assert.equal(saved.items.length,8);
 assert.equal(saved.items.find(item=>item.id==='existing').intervalKm,18000);
 assert.equal(saved.due.find(item=>item.key==='brakeFluid').dueDate,plusMonths(day(-700),36));
 assert.equal(saved.due.find(item=>item.key==='inspection').dueDate,plusMonths(day(-700),36));
 assert.equal(saved.due.find(item=>item.key==='coolant').dueDate,null);
 await stop();

 write({vehicle:{items:{oil},entries:{},mileage:[],maintenance:{profile:'custom'}}});
 await start();
 saved=(await api('GET','/vehicle')).data;
 assert.equal(saved.items.length,1);
 assert.equal(saved.maintenance.profile,'custom');
 console.log('Pi maintenance migration: legacy plan, alias, offline restart, pairing isolation, service references and due counts passed.');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
 await stop();
 fs.rmSync(data,{recursive:true,force:true});
});
