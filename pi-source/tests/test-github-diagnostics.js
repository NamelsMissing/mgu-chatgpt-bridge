'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {publisher,report}=require('../github-diagnostics');

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'github-diagnostics-test-'));
const file=path.join(tmp,'settings.json');
const repo='owner/private-diagnostics';
const token='github_pat_'+('fake_only_'.repeat(7));
const junk='secret-template-vin-key-AB123456789000000';
const poll={connection:'reachable',appState:'running',vehicle:'waiting',reason:junk,
 versions:{agent:'0.2.11',vehicleDataRunning:junk},lastOk:'2026-11-26T10:01:00Z',
 transfer:{snapshotAt:'2026-11-26T10:00:00Z',piReceivedAt:'2026-11-26T10:01:00Z'},
 stages:{'UDS.558E':{getter:'failed',decodeReason:'nrc_31',error:junk},unknown:{getter:junk}},
 received:{'UDS.558E':{valid:false,at:'2026-11-26T10:01:00Z',mileageKm:98181}},
 samples:{'UDS.558E':junk}};
const logs=[{endpoint:'/v1/status',status:200,outcome:'Antwort empfangen',at:poll.lastOk,url:junk},
 {endpoint:'/v1/vehicle/fault-memory',status:500,outcome:junk},
 {endpoint:'/v1/files/'+junk,status:500,outcome:'Timeout'}];
const json=(value,status=200)=>Response.json(value,{status});

(async()=>{
 let t=Date.parse(poll.lastOk),visibility='private',body=null,puts=0,fetches=0,failStatus=null;
 const request=async(url,options)=>{
  fetches++;
  assert.ok(url.startsWith('https://api.github.com/repos/'+repo));
  assert.equal(options.headers.authorization,'Bearer '+token);
  assert.equal(options.redirect,'error');
  if(!url.includes('/contents/'))return json({full_name:repo,private:visibility==='private',visibility});
  assert.ok(url.endsWith('/contents/diagnostics/latest.json'));
  if(options.method==='PUT'){
   const sent=JSON.parse(options.body);
   assert.equal(sent.sha,body?'b'.repeat(40):undefined);
   if(failStatus)return json({message:junk},failStatus);
   body=Buffer.from(sent.content,'base64').toString();
   puts++;
   return json({},201);
  }
  return body?json({type:'file',sha:'b'.repeat(40),encoding:'base64',content:Buffer.from(body).toString('base64')}):json({},404);
 };
 const safe=report(poll,logs,'0.10.7',poll.lastOk);
 assert.equal(safe.sources['UDS.558E'].reason,'nrc_31');
 assert.equal(safe.status.versions.vehicleData,null);
 assert.deepEqual(Object.keys(safe.requests),['/v1/status']);
 assert.equal(safe.lastSnapshotAt,'2026-11-26T10:00:00.000Z');
 assert.doesNotMatch(JSON.stringify(safe),/secret-template|98181|github_pat_/);
 const good={...poll,vehicle:'ok',received:{},stages:{}};
 const make=()=>publisher(file,{request,clock:()=>t});
 let writer=make();
 await writer.tick(poll,logs,'0.10.7');
 assert.equal(fetches,0,'disabled by default');
 assert.throws(()=>writer.configure({repo,enabled:true,token:''}),/erforderlich/);
 writer.configure({repo,enabled:true,token});
 assert.equal(fs.statSync(file).mode&0o777,0o600);
 assert.doesNotMatch(JSON.stringify(writer.view()),/github_pat_/);
 await writer.tick(good,logs,'0.10.7');
 assert.equal(fetches,0,'initial healthy state is local');
 await writer.tick(poll,logs,'0.10.7');
 assert.equal(puts,1);
 assert.doesNotMatch(body,/secret-template|98181|github_pat_/);
 await writer.tick(good,logs,'0.10.7');
 assert.equal(puts,1,'rate limited');
 writer=make();
 await writer.tick(good,logs,'0.10.7');
 assert.equal(puts,1,'rate limit survives restart');
 t+=301000;
 await writer.tick({...poll,lastOk:new Date(t).toISOString()},logs,'0.10.7');
 assert.equal(puts,1,'different timestamps do not create a new commit');
 await writer.tick(good,logs,'0.10.7');
 assert.equal(puts,2,'a recovery after a reported problem gets recorded');
 t+=301000;visibility='public';
 const before=fetches;
 await writer.tick(poll,logs,'0.10.7');
 assert.equal(fetches-before,1,'verify privacy before accessing any content');
 assert.equal(puts,2);
 assert.equal(writer.view().lastError,'repository_not_private');
 t+=301000;visibility='private';failStatus=409;
 await writer.tick(poll,logs,'0.10.7');
 assert.equal(writer.view().lastError,'write_http_409');
 assert.doesNotMatch(JSON.stringify(writer.view()),/secret-template|github_pat_/);
 t+=301000;failStatus=null;
 await writer.tick(poll,logs,'0.10.7');
 assert.equal(puts,3,'retry after GitHub conflict');
 writer.configure({repo,enabled:false,token:''});
 t+=301000;
 await writer.tick(good,logs,'0.10.7');
 assert.equal(puts,3,'disable stops future attempts');

 // The real web route enforces owner auth and never returns the PAT.
 const routeData=path.join(tmp,'route');
 Object.assign(process.env,{LOGIN_PASSWORD:'github-diagnostics-test-password',DATA_DIR:routeData});
 const srv=http.createServer(require('../server').route);
 await new Promise(resolve=>srv.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+srv.address().port;
 try{
  const url=origin+'/api/v1/github-diagnostics';
  assert.equal((await fetch(url)).status,401);
  const login=await fetch(origin+'/api/v1/login',{method:'POST',body:JSON.stringify({password:process.env.LOGIN_PASSWORD})});
  const headers={authorization:'Bearer '+(await login.json()).token,'content-type':'application/json'};
  const response=await fetch(url,{method:'POST',headers,body:JSON.stringify({repo,enabled:false,token})});
  assert.equal(response.status,200);
  assert.equal((await response.json()).hasToken,true);
  assert.doesNotMatch(await (await fetch(url,{headers})).text(),/github_pat_/);
  assert.equal((await fetch(url,{headers:{...headers,'tailscale-funnel-request':'1'}})).status,404);
 }finally{await new Promise(resolve=>srv.close(resolve));}
 console.log('GitHub diagnostics: opt-in, privacy check, safe fields, deduplication, retries and authenticated settings passed.');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>fs.rmSync(tmp,{recursive:true,force:true}));
