'use strict';
// Diagnosemodus + MCP für Claude: Ende-zu-Ende gegen eine simulierte MGU und ein simuliertes
// Tailscale-CLI. Prüft vor allem, was NICHT gehen darf.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const http=require('node:http');
const os=require('node:os');
const path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bmw-ai-mcp-'));
const tsLog=path.join(temp,'tailscale.log'),tsBin=path.join(temp,'tailscale');
const tsFail=path.join(temp,'tailscale.fail');
fs.writeFileSync(tsBin,'#!/bin/sh\nif [ "$1" = status ]; then echo \'{"Self":{"DNSName":"bmw-ai-pi.example-tailnet.ts.net."}}\'; exit 0; fi\n'
 +'if [ -f "'+tsFail+'" ]; then echo "Funnel is not enabled on your tailnet. To enable, visit: https://login.tailscale.com/f/funnel?node=abc"; exit 1; fi\n'
 +'echo "$@" >> "'+tsLog+'"\n',{mode:0o755});
process.env.LOGIN_PASSWORD='test-only-secure-password-not-used-in-production';
process.env.DATA_DIR=temp;
process.env.HOST='127.0.0.1';
process.env.PORT='8790';
process.env.BMW_AI_UPDATE_ROOT=path.join(temp,'updater');
process.env.TAILSCALE_BIN=tsBin;
delete process.env.MCP_PUBLIC_URL;
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const session=crypto.randomBytes(32).toString('base64url');
const PUBLIC='bmw-ai-pi.example-tailnet.ts.net',CALLBACK='https://claude.ai/api/mcp/auth_callback';

(async()=>{
 // Simulierte MGU: beantwortet nur, was die Website nach einer Freigabe anfragt.
 const mguCalls=[];
 const mgu=http.createServer((req,res)=>{
  let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
   mguCalls.push(req.method+' '+req.url+' '+raw);
   if(req.url==='/v1/console'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({stdout:'cinemo_options.xml\n',exitCode:0}));}
   if(req.url==='/v1/files/read'){res.writeHead(200,{'content-type':'application/octet-stream'});return res.end('audio.route=carplay\n');}
   res.writeHead(404);res.end('{}');
  });
 });
 await new Promise(resolve=>mgu.listen(0,'127.0.0.1',resolve));
 fs.writeFileSync(path.join(temp,'state.json'),JSON.stringify({
  sessions:{[sha(session)]:{expires:new Date(Date.now()+3600000).toISOString()}},
  conversations:{},messages:{},jobs:{},reports:{},files:{},logs:[],
  mguConnection:{url:'http://127.0.0.1:'+mgu.address().port,token:'a'.repeat(64)}}));
 const {route}=require('../server.js');
 const server=http.createServer(route);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const owner={authorization:'Bearer '+session,'content-type':'application/json'};
 const funnel={'tailscale-funnel-request':'?1','x-forwarded-host':PUBLIC};
 const site=async(method,p,data,headers=owner)=>{const r=await fetch(base+p,{method,headers,body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json().catch(()=>null)};};
 const pub=(p,init={})=>fetch(base+p,{redirect:'manual',...init,headers:{...funnel,...(init.headers||{})}});
 const rpc=async(token,method,params,id=1)=>{
  const r=await pub('/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
  return {status:r.status,data:await r.json().catch(()=>null)};
 };
 const tool=async(token,name,args={})=>{const r=await rpc(token,'tools/call',{name,arguments:args});assert.equal(r.status,200);const c=r.data.result;return {isError:c.isError,data:c.isError?c.content[0].text:JSON.parse(c.content[0].text)};};
 const tsLines=()=>fs.existsSync(tsLog)?fs.readFileSync(tsLog,'utf8').trim().split('\n'):[];
 try{
  // 1. Modus aus: MCP und OAuth sind zu, öffentliche Anfragen sehen weder Website noch API.
  assert.equal((await pub('/mcp',{method:'POST',body:'{}'})).status,503);
  assert.equal((await pub('/.well-known/oauth-authorization-server')).status,503);
  assert.equal((await pub('/oauth/register',{method:'POST',body:'{}'})).status,503);
  assert.equal((await pub('/')).status,404,'website must not be reachable through Funnel');
  assert.equal((await pub('/health')).status,404);
  assert.equal((await pub('/api/v1/login',{method:'POST',headers:{'content-type':'application/json'},body:'{"password":"x"}'})).status,404,'no public password guessing');
  assert.equal((await pub('/api/v1/jobs',{headers:owner})).status,404,'even a valid session is useless through Funnel');
  assert.equal((await fetch(base+'/')).status,200,'tailnet access to the website keeps working');

  // 1b. 30-Tage-Login über http://<Tailnet-IP>: eigenes Cookie ohne Secure, sonst wie bisher.
  const login=(host,plainHttp)=>new Promise((resolve,reject)=>{
   const q=http.request(base+'/api/v1/login',{method:'POST',headers:{host,'content-type':'application/json'}},s=>{s.resume();s.on('end',()=>resolve(String(s.headers['set-cookie']||'')));});
   q.on('error',reject);q.end(JSON.stringify({password:process.env.LOGIN_PASSWORD,remember:true,plainHttp}));});
  let jar=await login('100.65.28.85:8790',true);
  assert.match(jar,/^bmw_ai_session_http=[A-Za-z0-9_-]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Strict$/);
  const cookie=jar.split(';')[0];
  assert.equal((await fetch(base+'/api/v1/session',{headers:{cookie}})).status,200);
  assert.equal((await fetch(base+'/api/v1/diag-mode',{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{"enabled":false}'})).status,401,'cookie alone cannot change state (CSRF guard)');
  assert.equal((await pub('/api/v1/session',{headers:{cookie}})).status,404,'http cookie is useless through Funnel');
  assert.match(await login('100.65.28.85:8790',false),/^__Host-bmw_ai_session=.*; Secure;/);
  assert.match(await login('bmw-ai-pi.example-tailnet.ts.net',true),/^__Host-bmw_ai_session=.*; Secure;/,'never a non-Secure cookie for the public name');
  assert.match(await login('evil.example:8790',true),/; Secure;/);

  // 2. Einschalten geht nur mit Login und nur mit einer erlaubten Dauer.
  assert.equal((await site('POST','/api/v1/diag-mode',{enabled:true,minutes:30},{'content-type':'application/json'})).status,401);
  assert.equal((await site('POST','/api/v1/diag-mode',{enabled:true,minutes:9999})).status,400);
  let view=(await site('GET','/api/v1/diag-mode')).data;
  assert.equal(view.active,false);
  view=(await site('POST','/api/v1/diag-mode',{enabled:true,minutes:30})).data;
  assert.equal(view.active,true);assert.ok(Date.parse(view.until)>Date.now()+29*60000);
  assert.equal(view.mcpUrl,'https://'+PUBLIC+'/mcp','address for Claude does not depend on how the website was opened');
  assert.equal(tsLines().length,0,'no tailscale command while automatic Funnel is off');
  assert.equal((await pub('/')).status,404,'website stays closed to Funnel while the mode is on');

  // 3. Discovery, wie Claude sie erwartet.
  let r=await pub('/mcp',{method:'POST',body:'{}'});
  assert.equal(r.status,401);
  assert.match(r.headers.get('www-authenticate'),new RegExp('resource_metadata="https://'+PUBLIC.replace(/\./g,'\\.')+'/\\.well-known/oauth-protected-resource/mcp"'));
  const prm=await (await pub('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(prm.resource,'https://'+PUBLIC+'/mcp');assert.deepEqual(prm.authorization_servers,['https://'+PUBLIC]);
  const meta=await (await pub('/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(meta.code_challenge_methods_supported,['S256']);assert.ok(meta.token_endpoint_auth_methods_supported.includes('none'));
  assert.equal(meta.registration_endpoint,'https://'+PUBLIC+'/oauth/register');

  // 4. Registrierung: nur Claudes Callback oder Loopback.
  const register=uris=>pub('/oauth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'Claude',redirect_uris:uris})});
  assert.equal((await register(['https://evil.example/callback'])).status,400);
  assert.equal((await register([CALLBACK,'https://evil.example/callback'])).status,400);
  assert.equal((await register(['http://localhost:3118/callback'])).status,201,'Claude Code loopback redirect');
  r=await register([CALLBACK]);assert.equal(r.status,201);
  const client=await r.json();assert.equal(client.token_endpoint_auth_method,'none');

  // 5. Verbindung: öffentliche Seite zeigt nur einen Code, erlaubt wird auf der Website.
  const connect=async(decision)=>{
   const verifier=crypto.randomBytes(32).toString('base64url'),challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
   const q=new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:CALLBACK,code_challenge:challenge,code_challenge_method:'S256',state:'st-1',resource:'https://'+PUBLIC+'/mcp'});
   let a=await pub('/oauth/authorize?'+q);assert.equal(a.status,302);
   const statusPath=a.headers.get('location');assert.match(statusPath,/^\/oauth\/authorize\/status\?request=/);
   a=await pub(statusPath);assert.equal(a.status,200);
   const page=await a.text();const shown=/<div class="code">(\d{6})<\/div>/.exec(page);
   assert.ok(shown,'page shows a six-digit code');assert.doesNotMatch(page,/<input|<form|<script/i,'no password field or script on the public page');
   assert.match(a.headers.get('content-security-policy'),/default-src 'none'/);
   const pending=(await site('GET','/api/v1/diag-mode')).data.requests;
   const mine=pending.find(x=>x.code===shown[1]);assert.ok(mine,'website lists the request with the same code');
   assert.equal(mine.redirectHost,'claude.ai');
   assert.equal((await pub('/api/v1/diag-mode/requests/'+mine.id+'/approve',{method:'POST',headers:owner})).status,404,'cannot approve through Funnel');
   assert.equal((await site('POST','/api/v1/diag-mode/requests/'+mine.id+'/'+decision)).status,200);
   a=await pub(statusPath);assert.equal(a.status,302);
   const dest=new URL(a.headers.get('location'));assert.equal(dest.origin+dest.pathname,CALLBACK);assert.equal(dest.searchParams.get('state'),'st-1');
   assert.equal((await pub(statusPath)).status,410,'status link is single use');
   return {verifier,dest};
  };
  const token=form=>pub('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form)});
  assert.equal((await connect('deny')).dest.searchParams.get('error'),'access_denied');
  let flow=await connect('approve');
  r=await token({grant_type:'authorization_code',code:flow.dest.searchParams.get('code'),client_id:client.client_id,redirect_uri:CALLBACK,code_verifier:'x'.repeat(43)});
  assert.equal(r.status,400);assert.equal((await r.json()).error,'invalid_grant');
  r=await token({grant_type:'authorization_code',code:flow.dest.searchParams.get('code'),client_id:client.client_id,redirect_uri:CALLBACK,code_verifier:flow.verifier});
  assert.equal(r.status,400,'a code is burned by a failed attempt');
  flow=await connect('approve');
  r=await token({grant_type:'authorization_code',code:flow.dest.searchParams.get('code'),client_id:client.client_id,redirect_uri:CALLBACK,code_verifier:flow.verifier});
  assert.equal(r.status,200);
  let tokens=await r.json();assert.equal(tokens.token_type,'Bearer');assert.ok(tokens.refresh_token);
  assert.doesNotMatch(fs.readFileSync(path.join(temp,'state.json'),'utf8'),new RegExp(tokens.access_token),'only token hashes are stored');

  // 6. Die beiden Zugänge sind getrennt.
  assert.equal((await site('GET','/api/v1/jobs',null,{authorization:'Bearer '+tokens.access_token})).status,401,'Claude token is not a website login');
  assert.equal((await rpc(session,'ping')).status,401,'website session is not an MCP token');

  // 7. MCP: initialisieren, Werkzeuge, vorschlagen.
  r=await rpc(tokens.access_token,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'claude-ai',version:'1'}});
  assert.equal(r.status,200);assert.equal(r.data.result.protocolVersion,'2025-06-18');assert.ok(r.data.result.capabilities.tools);
  r=await pub('/mcp',{method:'POST',headers:{authorization:'Bearer '+tokens.access_token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
  assert.equal(r.status,202);
  assert.equal((await pub('/mcp',{headers:{authorization:'Bearer '+tokens.access_token}})).status,405);
  const tools=(await rpc(tokens.access_token,'tools/list')).data.result.tools;
  assert.equal(tools.length,11);
  const fjob=(await tool(tokens.access_token,'request_fault_memory_read',{reason:'Fehlerspeicher prüfen'})).data;
  assert.equal(fjob.type,'faults');assert.equal(fjob.status,'pending');
  assert.equal((await site('POST','/api/v1/jobs/'+fjob.job_id+'/reject')).status,200);
  assert.equal(tools.find(t=>t.name==='get_vehicle_overview').annotations.readOnlyHint,true);
  const overview=(await tool(tokens.access_token,'get_vehicle_overview')).data;
  assert.equal(overview.due[0].item,'Motoröl und Ölfilter');assert.equal(overview.due[0].interval.km,8000);
  assert.equal((await tool(tokens.access_token,'report_log_files',{paths:'/var/log/x.log'})).isError,true,'paths must be an array');
  const reported=(await tool(tokens.access_token,'report_log_files',{paths:['/var/log/oap/a.log','/etc/shadow'],note:'beim Suchen gefunden'})).data;
  assert.deepEqual(reported.reported.map(r=>r.status),['new','rejected']);assert.equal(reported.auto_save,false);
  assert.equal((await site('GET','/api/v1/found-logs')).data.found[0].foundBy,'claude');
  assert.equal(mguCalls.length,0,'reporting logs does not contact the vehicle');
  assert.ok(tools.every(t=>!/approve|freigeb|action|shell|write/i.test(t.name)),'no approval, action or write tool exists');
  assert.equal((await rpc(tokens.access_token,'resources/list')).data.error.code,-32601);
  assert.equal((await tool(tokens.access_token,'request_console_command',{command:'ls /etc/cinemo',reason:'x',approve:true})).isError,true,'unknown arguments are rejected');
  assert.equal((await tool(tokens.access_token,'request_diagnostic',{preset:'everything',reason:'x'})).isError,true);
  let job=(await tool(tokens.access_token,'request_console_command',{command:'ls /etc/cinemo',reason:'Welche Cinemo-Dateien gibt es?'})).data;
  assert.equal(job.status,'pending');
  assert.equal(mguCalls.length,0,'proposing must not contact the vehicle');
  assert.equal((await tool(tokens.access_token,'get_job_result',{job_id:job.job_id})).data.status,'pending');
  const listed=(await site('GET','/api/v1/jobs')).data.jobs.find(j=>j.id===job.job_id);
  assert.equal(listed.source,'claude');assert.equal(listed.status,'pending');
  assert.equal((await site('GET','/api/v1/diag-mode')).data.pendingClaudeJobs,1);

  // 8. Erst die Freigabe auf der Website führt aus; Claude wartet per get_job_result.
  const waiting=tool(tokens.access_token,'get_job_result',{job_id:job.job_id,wait_seconds:10});
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal((await site('POST','/api/v1/jobs/'+job.job_id+'/approve')).status,200);
  const done=(await waiting).data;
  assert.equal(done.status,'done');assert.equal(done.result.stdout,'cinemo_options.xml\n');
  assert.equal(mguCalls.length,1);assert.match(mguCalls[0],/POST \/v1\/console .*ls \/etc\/cinemo/);

  // 9. Abgelehnt bleibt abgelehnt; fremde Aufträge sind für Claude unsichtbar.
  job=(await tool(tokens.access_token,'request_file_download',{path:'/etc/cinemo/cinemo_options.conf',reason:'Audio-Routing lesen'})).data;
  assert.equal((await site('POST','/api/v1/jobs/'+job.job_id+'/reject')).status,200);
  assert.equal((await tool(tokens.access_token,'get_job_result',{job_id:job.job_id})).data.status,'rejected');
  const local=(await site('POST','/api/v1/jobs',{type:'console',payload:{command:'uname -a'},reason:'eigener Auftrag'})).data.job;
  assert.equal(local.source,'local');
  assert.equal((await tool(tokens.access_token,'get_job_result',{job_id:local.id})).isError,true);
  assert.ok((await tool(tokens.access_token,'list_jobs')).data.jobs.every(j=>j.job_id!==local.id));
  await site('POST','/api/v1/jobs/'+local.id+'/reject');

  // 10. Freigegebene kleine Textdatei kommt als Text zurück.
  job=(await tool(tokens.access_token,'request_file_download',{path:'/etc/cinemo/cinemo_options.conf',reason:'Audio-Routing lesen'})).data;
  assert.equal((await site('POST','/api/v1/jobs/'+job.job_id+'/approve')).status,200);
  const file=(await tool(tokens.access_token,'get_job_result',{job_id:job.job_id})).data;
  assert.equal(file.text,'audio.route=carplay\n');

  // 11. Refresh-Token rotieren.
  r=await token({grant_type:'refresh_token',refresh_token:tokens.refresh_token,client_id:client.client_id});
  assert.equal(r.status,200);const rotated=await r.json();
  r=await token({grant_type:'refresh_token',refresh_token:tokens.refresh_token,client_id:client.client_id});
  assert.equal(r.status,400);assert.equal((await r.json()).error,'invalid_grant');
  tokens=rotated;
  assert.equal((await rpc(tokens.access_token,'ping')).status,200);

  // 12. Automatischer Funnel: mit dem Modus auf, mit dem Ende wieder zu.
  fs.writeFileSync(tsFail,'1');
  view=(await site('POST','/api/v1/diag-mode/funnel',{auto:true})).data;
  assert.match(view.funnel.error,/https:\/\/login\.tailscale\.com\/f\/funnel\?node=abc/,'the real Tailscale message reaches the website');
  assert.equal(view.funnel.public,null);
  fs.rmSync(tsFail);
  await site('POST','/api/v1/diag-mode/funnel',{auto:false});
  view=(await site('POST','/api/v1/diag-mode/funnel',{auto:true})).data;
  assert.equal(view.funnel.public,true);
  assert.equal(tsLines().at(-1),'funnel --bg --https=443 http://127.0.0.1:8790');
  job=(await tool(tokens.access_token,'request_vehicle_status',{reason:'Status prüfen'})).data;
  view=(await site('POST','/api/v1/diag-mode',{enabled:false})).data;
  assert.equal(view.active,false);assert.equal(view.funnel.public,false);
  assert.equal(tsLines().at(-1),'serve --bg --https=443 http://127.0.0.1:8790');
  assert.equal((await rpc(tokens.access_token,'ping')).status,503,'valid token is useless once the mode is off');
  assert.equal((await site('POST','/api/v1/jobs/'+job.job_id+'/approve')).status,400,'open proposals die with the mode');
  assert.equal((await site('GET','/api/v1/jobs')).data.jobs.find(j=>j.id===job.job_id).status,'expired');

  // 13. Wieder einschalten: Verbindung besteht weiter, bis sie widerrufen wird.
  view=(await site('POST','/api/v1/diag-mode',{enabled:true,minutes:120})).data;
  assert.equal(tsLines().at(-1),'funnel --bg --https=443 http://127.0.0.1:8790');
  assert.equal((await rpc(tokens.access_token,'ping')).status,200);
  assert.equal(view.clients.length,1);assert.equal(view.clients[0].name,'Claude');
  assert.equal((await site('POST','/api/v1/diag-mode/clients/'+view.clients[0].id+'/revoke')).status,200);
  assert.equal((await rpc(tokens.access_token,'ping')).status,401);
  r=await token({grant_type:'refresh_token',refresh_token:tokens.refresh_token,client_id:client.client_id});
  assert.equal(r.status,400);
  view=(await site('POST','/api/v1/diag-mode/funnel',{auto:false})).data;
  assert.equal(view.autoFunnel,false);assert.equal(tsLines().at(-1),'serve --bg --https=443 http://127.0.0.1:8790','switching the automation off closes the port first');
  await site('POST','/api/v1/diag-mode',{enabled:false});

  // 14. Die Oberfläche bietet den Schalter an.
  const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  const js=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  for(const id of ['diagModeToggle','diagModeMinutes','diagModeState','diagMcpUrl','diagRequests','diagClients','diagAutoFunnel','diagFunnelLink','jobBadge'])
   assert.match(html,new RegExp('id="'+id+'"'),'Missing diagnostic-mode control: '+id);
  assert.match(js,/\/diag-mode/);
  assert.match(js,/if\(!kept\)\{d=await postLogin\(false\)/,'login falls back when the browser drops the Secure cookie');
  console.log('BMW AI Claude/MCP tests passed: closed by default, Funnel guard, OAuth with website approval, propose-only tools, per-job approval, rotation, revocation, automatic Funnel.');
 }finally{
  await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>mgu.close(resolve));
  fs.rmSync(temp,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
