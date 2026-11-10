'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto'),cp=require('child_process');
const {createBroker}=require('../broker/server'),{createAgent}=require('../agent/agent'),executor=require('../agent/executor'),p=require('../shared/protocol');
async function main(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mgu-bridge-test-')),app=createBroker({dataDir:path.join(dir,'broker')});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 let checks=0;function check(v,msg){assert.ok(v,msg);checks++;}
 async function request(route,key,body,method){const res=await fetch(base+route,{method:method||(body===undefined?'GET':'POST'),headers:{...(key?{Authorization:'Bearer '+key}:{}),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});const text=await res.text();return {status:res.status,body:text?JSON.parse(text):null};}
 async function mcp(name,args){const r=await request('/mcp',app.state.mcp,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});return r.body.result;}
 let agent;
 try{
  check((await request('/owner/state',app.state.mcp)).status===401,'MCP key must not access owner portal');
  check((await request('/mcp','wrong',{jsonrpc:'2.0',id:1,method:'tools/list'})).status===401,'Wrong MCP key rejected');
  check((await request('/owner/state')).status===401,'No unauthenticated owner access');
  const pair=await request('/owner/pair',app.state.owner,{label:'Test BMW'}),joined=await request('/device/pair','',{code:pair.body.code});
  check(joined.status===200,'Pairing succeeds');check((await request('/device/pair','',{code:pair.body.code})).status===401,'Pair code single use');
  const cfg=path.join(dir,'config.json'),data=path.join(dir,'agent'),files=path.join(dir,'readable');fs.mkdirSync(data);fs.mkdirSync(files);fs.writeFileSync(path.join(files,'audio.conf'),'example audio configuration');
  fs.writeFileSync(cfg,JSON.stringify({server:base,...joined.body,enabled:true,allowShell:false,dataDir:data,allowedReadRoots:[files]}));
  agent=createAgent(cfg,{directTransport:true});
  let proposed=JSON.parse((await mcp('request_system',{deviceId:joined.body.deviceId,reason:'System test'})).content[0].text);
  await agent.tick();check(app.state.jobs[proposed.id].status==='pending','Unapproved job never delivered');
  check((await request('/owner/jobs/'+proposed.id+'/approve',app.state.mcp,{hash:proposed.hash})).status===401,'ChatGPT cannot approve');
  check((await request('/owner/jobs/'+proposed.id+'/approve',app.state.owner,{hash:'modified'})).status===400,'Approval bound to exact hash');
  check((await request('/owner/jobs/'+proposed.id+'/approve',app.state.owner,{hash:proposed.hash})).status===200,'Owner approval succeeds');
  await agent.tick();check(app.state.jobs[proposed.id].status==='done','Approved job executed and returned');check(app.state.jobs[proposed.id].result.data.commands[0].exitCode===0,'Actual uname executed');
  check((await request('/owner/jobs/'+proposed.id+'/approve',app.state.owner,{hash:proposed.hash})).status===400,'Approval cannot be reused');
  const one=await mcp('request_file_chunk',{deviceId:joined.body.deviceId,reason:'Read test configuration',path:path.join(files,'audio.conf'),offset:0,length:128});let j=JSON.parse(one.content[0].text);app.approve(j.id,j.hash);await agent.tick();check(Buffer.from(app.state.jobs[j.id].result.data.data,'base64').toString()==='example audio configuration','File transfer exact bytes');
  j=app.propose(joined.body.deviceId,{type:'shell',command:'printf should-not-run'},'Shell disabled test');app.approve(j.id,j.hash);await agent.tick();check(!app.state.jobs[j.id].result.ok&&/disabled/.test(app.state.jobs[j.id].result.error),'Shell disabled locally');
  j=app.propose(joined.body.deviceId,{type:'catalog',name:'system'},'Expiry test');app.approve(j.id,j.hash);app.state.jobs[j.id].expiresAt=Date.now()-1;await agent.tick();check(app.state.jobs[j.id].status==='expired','Expired approval not executed');
  j=app.propose(joined.body.deviceId,{type:'catalog',name:'network'},'Rejection test');await request('/owner/jobs/'+j.id+'/reject',app.state.owner,{});await agent.tick();check(app.state.jobs[j.id].status==='rejected','Rejected job not executed');
  j=app.propose(joined.body.deviceId,{type:'catalog',name:'system'},'Pause test');app.approve(j.id,j.hash);agent.pause();await agent.tick();check(app.state.jobs[j.id].status==='approved','Local pause blocks poll/execution');agent.resume();await agent.tick();check(app.state.jobs[j.id].status==='done','Resume works');
  const outside=path.join(dir,'private.txt');fs.writeFileSync(outside,'private');fs.symlinkSync(outside,path.join(files,'link'));assert.throws(()=>executor.readFile({path:path.join(files,'link'),offset:0,length:10},agent.config),/outside/);checks++;
  fs.writeFileSync(path.join(files,'private.key'),'secret');assert.throws(()=>executor.readFile({path:path.join(files,'private.key'),offset:0,length:10},agent.config),/Sensitive/);checks++;
  cp.execFileSync('mkfifo',[path.join(files,'pipe')]);assert.throws(()=>executor.readFile({path:path.join(files,'pipe'),offset:0,length:10},agent.config),/regular/);checks++;
  // Crash/duplicate defense: mark an approved job seen, then ensure no second execution.
  j=app.propose(joined.body.deviceId,{type:'catalog',name:'system'},'Replay test');app.approve(j.id,j.hash);
  agent.stop();const ledger=JSON.parse(fs.readFileSync(path.join(data,'execution.json')));ledger.seen[j.id]={hash:j.hash,at:Date.now()};fs.writeFileSync(path.join(data,'execution.json'),JSON.stringify(ledger));agent=createAgent(cfg,{directTransport:true});await agent.tick();check(/Replayed/.test(agent.status().lastError)&&app.state.jobs[j.id].status==='running','Seen job blocked across restart');
  // OAuth complete flow including exact redirect binding, PKCE and single-use code.
  const reg=await request('/oauth/register','',{client_name:'Test client',redirect_uris:['http://127.0.0.1:9999/callback']});check(reg.status===201,'OAuth registration');
  const verifier=crypto.randomBytes(32).toString('base64url'),challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
  const query=new URLSearchParams({client_id:reg.body.client_id,redirect_uri:reg.body.redirect_uris[0],response_type:'code',code_challenge_method:'S256',code_challenge:challenge,state:'test-state'});
  const form=await (await fetch(base+'/oauth/authorize?'+query)).text(),ticket=form.match(/name="ticket" value="([^"]+)"/)[1];
  const auth=await fetch(base+'/oauth/authorize',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ticket,owner:app.state.owner}),redirect:'manual'});
  check(auth.status===302,'Owner authorizes OAuth connection');const location=new URL(auth.headers.get('location'));check(location.searchParams.get('state')==='test-state','OAuth state preserved');
  const code=location.searchParams.get('code'),params={grant_type:'authorization_code',code,client_id:reg.body.client_id,redirect_uri:reg.body.redirect_uris[0],code_verifier:verifier};
  check((await request('/oauth/token','',{...params,code_verifier:'a'.repeat(43)})).status===400,'Wrong PKCE rejected');
  const token=await request('/oauth/token','',params);check(token.status===200,'OAuth token exchange');check((await request('/oauth/token','',params)).status===400,'OAuth code single use');
  check((await request('/owner/state',token.body.access_token)).status===401,'OAuth token cannot approve');
  check((await request('/mcp',token.body.access_token,{jsonrpc:'2.0',id:2,method:'tools/list'})).status===200,'OAuth access can use MCP');
  const rotated=await request('/oauth/token','',{grant_type:'refresh_token',refresh_token:token.body.refresh_token,client_id:reg.body.client_id});check(rotated.status===200,'Refresh rotates token');check((await request('/oauth/token','',{grant_type:'refresh_token',refresh_token:token.body.refresh_token,client_id:reg.body.client_id})).status===400,'Refresh single use');
  await request('/owner/revoke',app.state.owner,{deviceId:joined.body.deviceId});check((await request('/device/poll',joined.body.deviceKey,{})).status===401,'Revoked device blocked');
  // State survives broker restart; secrets never returned in owner state.
  const stateView=await request('/owner/state',app.state.owner);check(!JSON.stringify(stateView.body).includes(joined.body.deviceKey),'Device secret absent from portal state');
  const saved=createBroker({dataDir:path.join(dir,'broker')});check(saved.state.devices[joined.body.deviceId].revoked,'Persisted revocation survives reload');saved.server.close();
  check(!p.equal(p.sign({id:1},'secret'),p.sign({id:2},'secret')),'Grant signature changes with payload');
  console.log('PASS: '+checks+' integration/security checks (real local broker and agent execution).');
 }finally{if(agent)agent.stop();await new Promise(r=>app.server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
