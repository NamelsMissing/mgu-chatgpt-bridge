'use strict';
// Web console and approvals: full shell on the MGU (agent shell.js, /bin/sh -c), direct runs for
// the logged-in owner, approval for proposed jobs, and the owner's auto-approval switch.
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const http=require('node:http'),crypto=require('node:crypto');
const shell=require('../../native/mgu-ai-agent/shell.js');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bmw-ai-console-test-'));
const runShell=body=>new Promise((resolve,reject)=>shell.run(body,(e,r)=>e?reject(e):resolve(r)));

// A local stand-in for the MGU agent that uses the real shell module.
const agentToken='a'.repeat(64),agentCalls=[];
const agent=http.createServer((req,res)=>{
  let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
    agentCalls.push(req.method+' '+req.url);
    if(req.headers.authorization!=='Bearer '+agentToken){res.writeHead(401);return res.end('{}');}
    if(req.method==='POST'&&req.url==='/v1/shell')return shell.run(JSON.parse(raw||'{}'),(e,r)=>{res.writeHead(e?e.status||500:200,{'content-type':'application/json'});res.end(JSON.stringify(e?{error:e.message}:r));});
    res.writeHead(404,{'content-type':'application/json'});res.end('{"error":"Not found"}');
  });
});

(async()=>{
  // ---- Agent shell: like SSH ----
  let r=await runShell({command:'printf "a\\nb\\nc\\n" | grep -c . ; for x in 1 2; do echo "v$x"; done; echo err 1>&2; exit 3'});
  assert.equal(r.stdout,'3\nv1\nv2\n','pipes, loops, variables');assert.equal(r.stderr,'err\n');assert.equal(r.exitCode,3);assert.equal(r.shell,true);
  const target=path.join(temp,'written.txt');
  r=await runShell({command:'echo hallo > '+target+' && cat '+target+' && cd '+temp+' && pwd'});
  assert.equal(r.stdout,'hallo\n'+fs.realpathSync(temp)+'\n','redirects, writes and cd within one command');
  r=await runShell({command:'cat <<EOF\nzeile 1\nzeile 2\nEOF'});
  assert.equal(r.stdout,'zeile 1\nzeile 2\n','multi-line scripts');
  r=await runShell({command:'sleep 5 & sleep 5; echo nie',timeoutSec:1});
  assert.equal(r.timedOut,true);assert.ok(r.durationMs<4500,'process group killed at the time limit');
  r=await runShell({command:'head -c 2000000 /dev/zero | tr "\\0" x'});
  assert.equal(r.stdout.length,shell.MAX_OUTPUT);assert.equal(r.truncated,true,'output capped at 1 MiB');
  await assert.rejects(runShell({command:'  '}),/command required/);
  await assert.rejects(runShell({command:'x'.repeat(shell.MAX_COMMAND+1)}),/longer than/);

  // ---- Website controls ----
  const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  const frontend=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  for(const id of ['consoleOutput','consoleInput','consoleCommandForm','consoleConnectionText','consoleDot','consoleRefreshConnection','consoleResult','consoleSend','consoleClear','consoleCopy','consoleExport','consoleTimeout','autoApproveEnabled','autoApproveHours','autoApproveInfo'])
    assert.match(html,new RegExp('id="'+id+'"'),'Missing control: '+id);
  assert.match(html,/<label class="console-input-label" for="consoleInput">BEFEHL EINGEBEN<\/label>/);
  assert.match(html,/data-console-command="ls -la \/dev\/shm; cat \/proc\/asound\/cards"/);
  assert.doesNotMatch(html,/keine freie SSH-Shell|Lesemodus/,'no read-only wording left');
  assert.match(frontend,/consoleHistoryIndex/);assert.match(frontend,/consoleTranscript/);
  assert.match(frontend,/api\('\/console\/run','POST'/);assert.match(frontend,/console:refreshConsoleConnection/);

  // ---- Pi ----
  await new Promise(resolve=>agent.listen(0,'127.0.0.1',resolve));
  process.env.LOGIN_PASSWORD='test-only-secure-password-not-for-production';
  process.env.DATA_DIR=temp;process.env.HOST='127.0.0.1';
  process.env.BMW_AI_UPDATE_ROOT=path.join(temp,'updater');
  const token=crypto.randomBytes(32).toString('base64url'),sessions={};
  sessions[crypto.createHash('sha256').update(token).digest('hex')]={expires:new Date(Date.now()+600000).toISOString()};
  fs.writeFileSync(path.join(temp,'state.json'),JSON.stringify({sessions,conversations:{},messages:{},jobs:{},reports:{},files:{},logs:[],
    mguConnection:{url:'http://127.0.0.1:'+agent.address().port,token:agentToken}}));
  const {route}=require('../server.js');
  const server=http.createServer(route);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port,headers={authorization:'Bearer '+token,'content-type':'application/json'};
  const call=async(method,p,body)=>{const res=await fetch(base+'/api/v1'+p,{method,headers,body:body&&JSON.stringify(body)});return {status:res.status,data:await res.json()};};
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  try{
    assert.equal((await fetch(base+'/api/v1/console/run',{method:'POST',headers:{'content-type':'application/json'},body:'{"command":"id"}'})).status,401);
    // The owner's own console input runs at once, with the full shell.
    let run=await call('POST','/console/run',{command:'echo $((6*7)) | tr 4 X; ls / | head -n 1 >/dev/null; echo ok',timeoutSec:30});
    assert.equal(run.status,200);assert.equal(run.data.stdout,'X2\nok\n');assert.equal(run.data.exitCode,0);
    assert.equal((await call('POST','/console/run',{command:''})).status,400);
    // Proposed jobs wait for approval while auto-approval is off.
    let state=(await call('GET','/jobs/auto-approve')).data;assert.deepEqual(state,{enabled:false,until:null});
    let job=(await call('POST','/jobs',{type:'console',payload:{command:'ls /dev/shm | wc -l'},reason:'Test'})).data.job;
    await sleep(300);
    assert.equal((await call('GET','/jobs')).data.jobs.find(j=>j.id===job.id).status,'pending','no execution without approval');
    // Switching auto-approval on also approves what is already waiting.
    state=(await call('POST','/jobs/auto-approve',{enabled:true,hours:0})).data;assert.deepEqual(state,{enabled:true,until:null});
    await sleep(500);
    let done=(await call('GET','/jobs')).data.jobs.find(j=>j.id===job.id);
    assert.equal(done.status,'done');assert.equal(done.autoApproved,true);assert.match(done.result.stdout,/^\d+\n$/);
    // New jobs run immediately, including writes and paths outside the old allowlist.
    const marker=path.join(temp,'auto.txt');
    job=(await call('POST','/jobs',{type:'console',payload:{command:'echo auto > '+marker+'; cat '+marker},reason:'Test'})).data.job;
    await sleep(500);
    done=(await call('GET','/jobs')).data.jobs.find(j=>j.id===job.id);
    assert.equal(done.status,'done');assert.equal(done.result.stdout,'auto\n');assert.equal(fs.readFileSync(marker,'utf8'),'auto\n');
    // Time limit, validation, switching off.
    state=(await call('POST','/jobs/auto-approve',{enabled:true,hours:8})).data;
    assert.ok(Math.abs(Date.parse(state.until)-Date.now()-8*3600000)<5000);
    assert.equal((await call('POST','/jobs/auto-approve',{enabled:'ja'})).status,400);
    assert.equal((await call('POST','/jobs/auto-approve',{enabled:true,hours:1.5})).status,400);
    state=(await call('POST','/jobs/auto-approve',{enabled:false})).data;assert.equal(state.enabled,false);
    job=(await call('POST','/jobs',{type:'console',payload:{command:'uname -a'},reason:'Test'})).data.job;
    await sleep(300);
    assert.equal((await call('GET','/jobs')).data.jobs.find(j=>j.id===job.id).status,'pending');
    const denied=await call('POST','/jobs/'+job.id+'/reject');
    assert.equal(denied.data.job.status,'rejected');
    const audit=JSON.parse(fs.readFileSync(path.join(temp,'state.json'),'utf8')).logs.map(l=>l.action);
    assert.ok(audit.includes('job_auto_approved')&&audit.includes('auto_approve')&&audit.includes('console_run'),'audit trail');
    console.log('BMW AI console: full shell (pipes, loops, writes, heredoc, timeout, output cap), direct owner runs, approval and auto-approval passed.');
  }finally{await new Promise(resolve=>server.close(resolve));agent.close();fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1);});
