'use strict';
// Fahrzeug/Service, MGU-Dateibrowser und gefundene Logs gegen eine simulierte MGU.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const http=require('node:http');
const os=require('node:os');
const path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bmw-ai-vehicle-'));
process.env.LOGIN_PASSWORD='test-only-secure-password-not-used-in-production';
process.env.DATA_DIR=temp;process.env.HOST='127.0.0.1';process.env.PORT='8791';
process.env.BMW_AI_UPDATE_ROOT=path.join(temp,'updater');process.env.TAILSCALE_BIN=path.join(temp,'no-tailscale');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const session=crypto.randomBytes(32).toString('base64url');
const day=(offset)=>{const d=new Date();d.setDate(d.getDate()+offset);return d.toLocaleDateString('sv-SE');};
const plusMonths=(iso,m)=>{const [y,mo,d]=iso.split('-').map(Number);const t=new Date(Date.UTC(y,mo-1+m,1));const last=new Date(Date.UTC(t.getUTCFullYear(),t.getUTCMonth()+1,0)).getUTCDate();t.setUTCDate(Math.min(d,last));return t.toISOString().slice(0,10);};

(async()=>{
 const files={'/var/log/oap/app.log':'boot ok\nerror: dsp timeout\n','/usr/lib/oap-mainapp/dsp.conf':'gain=3\n','/var/log/oap/app.log.1':'old\n'};
 let mileage=null,extra={};const calls=[];
 const mgu=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
  const b=raw?JSON.parse(raw):{};calls.push(req.url+' '+(b.path||b.command||''));
  const json=(c,d)=>{res.writeHead(c,{'content-type':'application/json'});res.end(JSON.stringify(d));};
  if(req.url==='/v1/status')return json(200,{online:true,host:'mgu',vehicle:mileage===null?{status:'unavailable'}:Object.assign({status:'ok',appState:'running',mileageAt:new Date().toISOString(),mileageSource:'SecureMileage',mileageKm:mileage},extra)});
  if(req.url==='/v1/files/list'){
   if(b.path==='/var/log/oap')return json(200,{path:'/var/log/oap',entries:[...Object.keys(files).filter(f=>f.startsWith('/var/log/oap/')).map(f=>({name:path.basename(f),kind:'file',bytes:files[f].length})),{name:'state',kind:'directory',bytes:0}]});
   if(b.path==='/usr/lib/oap-mainapp')return json(200,{path:b.path,entries:[{name:'dsp.conf',kind:'file',bytes:7}]});
   return json(400,{error:'Not a directory'});
  }
  if(req.url==='/v1/files/read'){if(!files[b.path])return json(400,{error:'missing'});res.writeHead(200,{'content-type':'application/octet-stream'});return res.end(files[b.path]);}
  if(req.url==='/v1/console'){
   const m=/^find (\S+) "(.+)"$/.exec(b.command||'');if(!m)return json(400,{error:'bad'});
   return json(200,{stdout:Object.keys(files).filter(f=>f.startsWith(m[1])&&f.toLowerCase().includes(m[2].toLowerCase())).join('\n')+'\n[read-only search; max depth 4, 180 matches]'});
  }
  json(404,{});
 });});
 await new Promise(r=>mgu.listen(0,'127.0.0.1',r));
 fs.writeFileSync(path.join(temp,'state.json'),JSON.stringify({sessions:{[sha(session)]:{expires:new Date(Date.now()+3600000).toISOString()}},conversations:{},messages:{},jobs:{},reports:{},files:{},logs:[],
  mguConnection:{url:'http://127.0.0.1:'+mgu.address().port,token:'a'.repeat(64)}}));
 const server=require('../server.js');
 const srv=http.createServer(server.route);await new Promise(r=>srv.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+srv.address().port,owner={authorization:'Bearer '+session,'content-type':'application/json'};
 const api=async(method,p,data)=>{const r=await fetch(base+'/api/v1'+p,{method,headers:owner,body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json().catch(()=>null)};};
 try{
  // ----- Service: Standard ist Öl 12 Monate / 8.000 km -----
  let v=(await api('GET','/vehicle')).data;
  assert.deepEqual(v.items.map(i=>[i.id,i.intervalMonths,i.intervalKm]),[['oil',12,8000]]);
  assert.equal(v.due[0].status,'unknown','no oil change recorded yet');
  assert.equal(v.mileage,null);
  assert.equal((await api('POST','/vehicle/mileage',{km:-5})).status,400);
  assert.equal((await api('POST','/vehicle/mileage',{km:1000,date:day(5)})).status,400,'no future dates');

  const lastOil=day(-200);
  v=(await api('POST','/vehicle/entries',{date:lastOil,km:100000,items:['oil'],title:'Inspektion',workshop:'Freie Werkstatt',cost:'189,90'})).data;
  assert.equal(v.entries[0].cost,189.9);
  let oil=v.due.find(d=>d.id==='oil');
  assert.equal(oil.dueDate,plusMonths(lastOil,12));assert.equal(oil.dueKm,108000);
  assert.equal(v.mileage,null,'a historic service odometer reading is not current mileage');
  assert.equal(oil.kmLeft,null,'remaining distance requires a measured or manually entered odometer');
  assert.equal(oil.status,'ok');

  v=(await api('POST','/vehicle/mileage',{km:106000,date:day(0)})).data;
  oil=v.due.find(d=>d.id==='oil');
  assert.equal(v.mileage.km,106000);assert.equal(oil.kmLeft,2000);
  assert.equal(v.kmPerDay,30,'6000 km in 200 days');
  assert.equal(oil.estimatedKmDate,day(67),'2000 km at 30 km/day');
  assert.equal(oil.firstBy,'km');assert.equal(oil.status,'ok');
  assert.equal((await api('POST','/vehicle/mileage',{km:105000,date:day(0)})).status,400,'mileage cannot go backwards');

  v=(await api('POST','/vehicle/mileage',{km:107500,date:day(0)})).data;
  assert.equal(v.due.find(d=>d.id==='oil').status,'soon');
  v=(await api('POST','/vehicle/mileage',{km:108100,date:day(0)})).data;
  assert.equal(v.due.find(d=>d.id==='oil').status,'overdue');

  // Fälligkeit von Hand setzen (z. B. laut Bordcomputer), gilt bis zum nächsten Ölwechsel.
  v=(await api('POST','/vehicle/items',{id:'oil',name:'Motoröl und Ölfilter',intervalMonths:12,intervalKm:8000,dueKm:115000})).data;
  oil=v.due.find(d=>d.id==='oil');assert.equal(oil.dueKm,115000);assert.ok(oil.override);assert.equal(oil.status,'ok');
  v=(await api('POST','/vehicle/entries',{date:day(0),km:108200,items:['oil']})).data;
  oil=v.due.find(d=>d.id==='oil');assert.equal(oil.override,null,'a newer oil change replaces the manual due value');
  assert.equal(oil.dueKm,116200);assert.equal(oil.dueDate,plusMonths(day(0),12));

  // Eigene Wartungsart mit nur einem Zeitintervall.
  v=(await api('POST','/vehicle/items',{name:'Bremsflüssigkeit',intervalMonths:24,intervalKm:0})).data;
  const brake=v.items.find(i=>i.name==='Bremsflüssigkeit');assert.ok(brake);
  assert.equal(v.due.find(d=>d.id===brake.id).status,'unknown');
  assert.equal((await api('POST','/vehicle/items',{name:'Nichts',intervalMonths:0,intervalKm:0})).status,400);
  assert.equal((await api('DELETE','/vehicle/items/oil')).status,400,'item in use cannot be deleted');
  assert.equal((await api('DELETE','/vehicle/items/'+brake.id)).status,200);
  assert.equal((await api('POST','/vehicle/entries',{date:day(0),items:['unknown']})).status,400);

  // Kilometerstand vom Fahrzeug, sobald der Agent einen liefert.
  mileage=108900;await api('GET','/status');
  v=(await api('GET','/vehicle')).data;assert.equal(v.mileage.km,108900);assert.equal(v.mileage.source,'vehicle');
  mileage=100;await api('GET','/status');
  assert.equal((await api('GET','/vehicle')).data.mileage.km,108900,'implausible vehicle value ignored');

  // ----- Servicebedarf und Servicehistorie laut Fahrzeug (App Vehicle Data über den Agent) -----
  mileage=109000;extra={unverified:true,source:'Vehicle Data 0.1.0',cbs:[{scope:'OELSERVICE',label:'Motoröl',remainingKm:7100,dueDate:'2027-11-01',raw:'x'}],
   serviceHistory:{status:'E_OK',sets:[{date:day(-30),km:108300,dealer:'12345',status:'SERVICE_PERFORMED',services:[{scope:'OELSERVICE',label:'Motoröl'},{scope:'MIKROFILTER',label:'Mikrofilter'}]},
    {date:day(-10),km:108900,dealer:'',status:'SERVICE_CARRIED_OUT_LATE',services:[{scope:'BREMSFLUESSIGKEIT',label:'Bremsflüssigkeit'}]}]}};
  await api('GET','/status');
  v=(await api('GET','/vehicle')).data;
  assert.equal(v.live.cbs[0].remainingKm,7100);assert.equal(v.live.cbs[0].raw,undefined,'only known fields are stored');
  assert.equal(v.live.serviceHistory.sets.length,2);assert.equal(v.live.serviceHistory.sets[0].imported,false);
  v=(await api('POST','/vehicle/import-history',{date:day(-30),km:108300})).data;
  const imported=v.entries.find(e=>e.date===day(-30));
  assert.deepEqual(imported.items,['oil']);assert.equal(imported.title,'Mikrofilter');assert.equal(imported.workshop,'Händler 12345');
  assert.equal(v.live.serviceHistory.sets.find(x=>x.date===day(-30)).imported,true);
  assert.equal((await api('POST','/vehicle/import-history',{date:day(-30),km:108300})).status,400,'no duplicates');
  assert.equal((await api('POST','/vehicle/import-history',{date:day(-400)})).status,400);
  v=(await api('POST','/vehicle/import-history',{date:day(-10),km:108900})).data;
  assert.match(v.entries.find(e=>e.date===day(-10)).notes,/verspätet/);

  // ----- Dateibrowser -----
  let r=await api('POST','/mgu/browse',{path:'/var/log/oap'});
  assert.equal(r.status,200);assert.equal(r.data.entries.length,3);
  assert.equal((await api('POST','/mgu/browse',{path:'/etc/shadow'})).status,400);
  assert.equal((await api('POST','/mgu/browse',{path:'/var/log/../../etc'})).status,400);
  r=await api('POST','/mgu/search',{root:'/var/log',term:'app'});
  assert.deepEqual(r.data.results,['/var/log/oap/app.log','/var/log/oap/app.log.1']);
  assert.equal((await api('POST','/mgu/search',{root:'/var/log',term:'a'})).status,400);
  r=await api('POST','/mgu/fetch',{path:'/usr/lib/oap-mainapp/dsp.conf'});
  assert.equal(r.data.file.kind,'mgu');assert.equal(r.data.duplicate,false);
  assert.equal((await api('POST','/mgu/fetch',{path:'/usr/lib/oap-mainapp/dsp.conf'})).data.duplicate,true,'same content is not stored twice');
  const dl=await fetch(base+'/api/v1/files/'+r.data.file.id+'/download',{headers:owner});assert.equal(await dl.text(),'gain=3\n');
  assert.equal((await api('DELETE','/files/'+r.data.file.id)).status,200);
  assert.equal((await api('GET','/files')).data.files.length,0);
  // Manuell als Log speichern.
  r=await api('POST','/mgu/fetch',{path:'/var/log/oap/app.log.1',kind:'log'});
  assert.equal(r.data.file.kind,'log');
  let found=(await api('GET','/found-logs')).data;
  assert.equal(found.found[0].status,'saved');assert.equal(found.found[0].foundBy,'manual');

  // ----- Von Claude gefundene Logs -----
  const job=server.jobFor('list',{path:'/var/log/oap'},null,'Logs suchen','claude');
  await server.runJob(job);
  found=(await api('GET','/found-logs')).data;
  const appLog=found.found.find(f=>f.path==='/var/log/oap/app.log');
  assert.equal(appLog.status,'new','manual mode: only listed');assert.equal(appLog.foundBy,'claude');
  assert.ok(!calls.some(c=>c==='/v1/files/read /var/log/oap/app.log'),'nothing fetched without the owner');
  const local=server.jobFor('list',{path:'/usr/lib/oap-mainapp'},null,'eigener Auftrag');
  await server.runJob(local);
  assert.equal((await api('GET','/found-logs')).data.found.length,2,'only Claude results are collected');

  found=(await api('POST','/found-logs/'+appLog.id+'/save')).data;
  assert.equal(found.found.find(f=>f.id===appLog.id).status,'saved');

  // Automatisch: neue Funde werden direkt geholt, auch aus Claudes Suchergebnissen.
  await api('POST','/found-logs/settings',{auto:true});
  files['/var/log/oap/new.log']='fresh\n';files['/var/log/oap/crash.txt']='trace\n';
  await server.runJob(server.jobFor('list',{path:'/var/log/oap'},null,'nochmal','claude'));
  await server.runJob(server.jobFor('console',{command:'find /var/log "crash"'},null,'suchen','claude'));
  for(let i=0;i<50&&(await api('GET','/found-logs')).data.found.some(f=>['queued','saving'].includes(f.status));i++)await new Promise(r=>setTimeout(r,40));
  found=(await api('GET','/found-logs')).data;
  assert.equal(found.found.find(f=>f.path==='/var/log/oap/new.log').status,'saved');
  assert.equal(found.found.find(f=>f.path==='/var/log/oap/crash.txt').status,'saved');
  const lib=(await api('GET','/files')).data.files;
  assert.ok(lib.some(f=>f.mguPath==='/var/log/oap/new.log'&&f.kind==='log'));
  assert.ok(!found.found.some(f=>f.path==='/etc/passwd'));
  // Ignorierte Logs bleiben ignoriert.
  const ign=found.found.find(f=>f.path==='/var/log/oap/app.log.1');
  assert.equal((await api('POST','/found-logs/'+ign.id+'/ignore')).data.found.find(f=>f.id===ign.id).status,'ignored');

  // ----- Oberfläche -----
  const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8'),js=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  for(const id of ['vehicle','bmwNextService','maintenanceSettings','toggleServiceHistory','mileageKm','addMileage','dueList','serviceForm','serviceEntries','itemForm','mguRoots','mguListing','mguSearchTerm','foundLogs','foundLogsAuto','libraryList','librarySearch'])
   assert.match(html,new RegExp('id="'+id+'"'),'Missing UI element: '+id);
  assert.match(html,/<section id="diag"[\s\S]*?id="vehicleTelemetry"[\s\S]*?<\/section>/);
  assert.match(js,/\/vehicle\/entries/);assert.match(js,/\/mgu\/browse/);assert.match(js,/\/found-logs/);
  console.log('BMW AI vehicle/files tests passed: service intervals, manual due values, mileage plausibility, vehicle mileage, file browser, dedupe, found logs manual/auto.');
 }finally{
  await new Promise(r=>srv.close(r));await new Promise(r=>mgu.close(r));fs.rmSync(temp,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
