'use strict';
// Hintergrundabfrage, Check-Control, Fehlerspeicher, Reifen, DPF und Benachrichtigungen.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const http=require('node:http');
const os=require('node:os');
const path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bmw-ai-monitor-'));
process.env.LOGIN_PASSWORD='test-only-secure-password-not-used-in-production';
process.env.DATA_DIR=temp;process.env.HOST='127.0.0.1';process.env.PORT='8792';
process.env.BMW_AI_UPDATE_ROOT=path.join(temp,'updater');process.env.TAILSCALE_BIN=path.join(temp,'no-tailscale');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const session=crypto.randomBytes(32).toString('base64url');
const iso=ms=>new Date(Date.now()+ms).toISOString();

(async()=>{
 let vehicle={status:'ok',mileageKm:120000,cbs:[],serviceHistory:null,checkControl:{active:[],events:[]},tyres:null,dpf:null,faultMemory:null};
 let mguUp=true,faultReply=null;
 const mgu=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
  const j=(c,d)=>{res.writeHead(c,{'content-type':'application/json'});res.end(JSON.stringify(d));};
  if(!mguUp){res.destroy();return;}
  if(req.url==='/v1/status')return j(200,{online:true,vehicle});
  if(req.url==='/v1/vehicle/fault-memory')return j(200,{faultMemory:faultReply});
  j(404,{});
 });});
 const pushes=[];
 const ntfy=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{pushes.push(JSON.parse(raw));res.writeHead(200);res.end('{}');});});
 await new Promise(r=>mgu.listen(0,'127.0.0.1',r));await new Promise(r=>ntfy.listen(0,'127.0.0.1',r));
 fs.writeFileSync(path.join(temp,'state.json'),JSON.stringify({sessions:{[sha(session)]:{expires:iso(3600000)}},conversations:{},messages:{},jobs:{},reports:{},files:{},logs:[],
  mguConnection:{url:'http://127.0.0.1:'+mgu.address().port,token:'a'.repeat(64)},
  notify:{enabled:true,server:'http://127.0.0.1:'+ntfy.address().port,topic:'bmw-ai-testtopic123',categories:{cc:true,service:true,faults:true,tyres:true},sent:{},log:[]}}));
 const server=require('../server.js');
 const srv=http.createServer(server.route);await new Promise(r=>srv.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+srv.address().port,owner={authorization:'Bearer '+session,'content-type':'application/json'};
 const api=async(method,p,data)=>{const r=await fetch(base+'/api/v1'+p,{method,headers:owner,body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json().catch(()=>null)};};
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 try{
  // ----- Abfrage im Hintergrund -----
  let poll=await server.pollOnce();assert.equal(poll.ok,true);
  assert.equal((await api('GET','/vehicle')).data.mileage.km,120000);
  mguUp=false;poll=await server.pollOnce();assert.equal(poll.ok,false);assert.ok(poll.lastOk,'last success is kept');mguUp=true;

  // ----- Check-Control -----
  vehicle.checkControl={active:[{id:220,text:'Kühlmittelstand zu niedrig',description:'Kühlmittel nachfüllen.',ecu:0x12,since:iso(-60000)}],
   events:[{id:220,active:true,text:'Kühlmittelstand zu niedrig',ecu:0x12,at:iso(-60000)}]};
  await server.pollOnce();await server.pollOnce();
  let f=(await api('GET','/faults')).data;
  assert.equal(f.checkControl.active.length,1);assert.equal(f.checkControl.active[0].ecuName,'DME/DDE Motor');
  await wait(50);
  assert.equal(pushes.filter(p=>/Kühlmittel/.test(p.title)).length,1,'one notification, not one per poll');
  assert.equal(pushes[0].topic,'bmw-ai-testtopic123');
  vehicle.checkControl={active:[],events:[{id:220,active:true,ecu:0x12,at:iso(-60000)},{id:220,active:false,ecu:0x12,at:iso(-1000)}]};
  await server.pollOnce();
  f=(await api('GET','/faults')).data;
  assert.equal(f.checkControl.active.length,0);assert.deepEqual(f.checkControl.events.slice(0,2).map(e=>e.active),[false,true]);

  // ----- Fehlerspeicher: Lesen auf Knopfdruck, neue Codes melden -----
  faultReply={requestId:'r1',readAt:iso(0),error:null,ecus:[{ecu:0x12,ok:true,count:1},{ecu:0x40,ok:true,count:0}],dtcs:[{ecu:0x12,code:'480A12',status:9,label:'ACTIVE',active:true}]};
  f=(await api('POST','/faults/read')).data;
  assert.equal(f.faultMemory.latest.dtcs[0].ecuName,'DME/DDE Motor');assert.equal(f.faultMemory.latest.dtcs[0].isNew,false,'first read: nothing is "new"');
  await wait(50);const before=pushes.length;
  faultReply={requestId:'r2',readAt:iso(1000),error:null,ecus:[{ecu:0x12,ok:true,count:1},{ecu:0x40,ok:true,count:1}],dtcs:[{ecu:0x40,code:'801234',status:8,label:'STORED',active:false}]};
  f=(await api('POST','/faults/read')).data;
  await wait(50);
  assert.equal(f.faultMemory.latest.dtcs[0].isNew,true);
  assert.equal(f.faultMemory.earlier[0].code,'480A12','codes no longer reported are kept as earlier');
  assert.equal(pushes.length,before+1);assert.match(pushes[pushes.length-1].message,/BDC_BODY3 Karosserie: 801234/);
  faultReply={requestId:'r3',readAt:iso(2000),error:'busy',ecus:[],dtcs:[]};
  f=(await api('POST','/faults/read')).data;
  assert.equal(f.faultMemory.lastAttempt.error,'busy');assert.equal(f.faultMemory.latest.dtcs[0].code,'801234','a failed read does not hide the last result');
  // Freigabe-Auftrag für Chat/Claude
  const job=server.jobFor('faults',{},null,'Fehlerspeicher','claude');
  faultReply={requestId:'r4',readAt:iso(3000),error:null,ecus:[],dtcs:[]};
  await server.runJob(job);assert.equal(job.status,'done');

  // ----- Reifen -----
  vehicle.tyres={wheels:[{position:'FRONT_LEFT',pressureBar:2.45,targetBar:2.5,temperatureC:18},{position:'REAR_RIGHT',pressureBar:2.1,targetBar:2.7,temperatureC:17}]};
  await server.pollOnce();await wait(50);
  let v=(await api('GET','/vehicle')).data;
  assert.deepEqual(v.tyres.wheels.map(w=>[w.name,w.p,w.low]),[['vorne links',2.45,false],['hinten rechts',2.1,true]]);
  assert.equal(pushes.filter(p=>/hinten rechts/.test(p.title)).length,1);
  await server.pollOnce();await wait(50);
  assert.equal(pushes.filter(p=>/hinten rechts/.test(p.title)).length,1,'no repeat within 12 h');

  // ----- DPF: Regeneration erkennen -----
  vehicle.dpf={at:iso(0),soot:24.5,ash:31.2,distance:410,regenCount:211};
  await server.pollOnce();
  vehicle.dpf={at:iso(600000),soot:3.1,ash:31.2,distance:12,regenCount:212};
  await server.pollOnce();
  v=(await api('GET','/vehicle')).data;
  assert.equal(v.dpf.regens.length,1);assert.equal(v.dpf.regens[0].distanceBefore,410);assert.equal(v.dpf.latest.soot,3.1);

  // ----- Service-Fälligkeit melden (eigene Wartungsarten und CBS) -----
  vehicle.cbs=[{scope:'OELSERVICE',label:'Motoröl',remainingKm:800,dueDate:null}];
  await server.pollOnce();await wait(50);
  assert.ok(pushes.some(p=>/Motoröl fällig/.test(p.title)));
  const n=pushes.length;await server.pollOnce();await wait(50);
  assert.equal(pushes.length,n,'service reminders are not repeated on every poll');

  // ----- Einstellungen -----
  let s=(await api('GET','/notify')).data;assert.equal(s.enabled,true);assert.ok(s.log.length>0);assert.equal(s.hasToken,false);
  assert.equal((await api('POST','/notify',{server:'http://ntfy.example'})).status,400,'https only');
  assert.equal((await api('POST','/notify',{topic:'kurz'})).status,400);
  s=(await api('POST','/notify',{categories:{tyres:false},token:'tk_abcdefgh123'})).data;
  assert.equal(s.categories.tyres,false);assert.equal(s.hasToken,true);assert.equal(s.token,undefined,'token is never returned');
  assert.equal((await api('POST','/notify/test')).status,200);
  await wait(50);assert.match(pushes[pushes.length-1].title,/Test/);

  // ----- Oberfläche -----
  const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8'),js=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  for(const id of ['faults','ccActive','ccEvents','faultRead','faultList','faultEarlier','tyreList','dpfPanel','dpfRegens','notifyEnabled','notifyServer','notifyTopic','notifyTest','notifyLog','pollInfo','faultBadge'])
   assert.match(html,new RegExp('id="'+id+'"'),'Missing UI element: '+id);
  assert.match(js,/\/faults\/read/);assert.match(js,/\/notify\/test/);
  console.log('BMW AI monitor tests passed: background poll, check-control, fault memory, tyres, DPF regenerations, service reminders, ntfy settings.');
 }finally{
  await new Promise(r=>srv.close(r));await new Promise(r=>mgu.close(r));await new Promise(r=>ntfy.close(r));fs.rmSync(temp,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
