'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const http=require('node:http'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bmw-ai-console-test-'));
process.env.LOGIN_PASSWORD='test-only-secure-password-not-for-production';
process.env.DATA_DIR=temp;
process.env.HOST='127.0.0.1';
process.env.BMW_AI_UPDATE_ROOT=path.join(temp,'updater');
const token=crypto.randomBytes(32).toString('base64url');
const sessions={};
sessions[crypto.createHash('sha256').update(token).digest('hex')]={expires:new Date(Date.now()+600000).toISOString()};
fs.writeFileSync(path.join(temp,'state.json'),JSON.stringify({sessions,conversations:{},messages:{},jobs:{},reports:{},files:{},logs:[]}));
const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
const frontend=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
for(const id of ['consoleOutput','consoleInput','consoleCommandForm','consoleApprove','consoleReject','consoleExact','consoleConnectionText','consoleDot','consoleRefreshConnection','consoleResult','consoleSend','consoleClear','consoleCopy','consoleExport']){
 assert.match(html,new RegExp('id="'+id+'"'),'Missing terminal control: '+id);
}
assert.match(html,/<label class="console-input-label" for="consoleInput">BEFEHL EINGEBEN<\/label>/);
assert.doesNotMatch(html,/class="panel"><p><strong>Beispiele:/,'Ambiguous old command box must be removed');
assert.match(html,/data-console-command="help"/);
assert.match(html,/data-console-command="find \/usr\/lib\/oap-mainapp dsp"/);
assert.match(frontend,/consoleHistoryIndex/);
assert.match(frontend,/consoleCommandSafetyProblem/);
assert.match(frontend,/consoleTranscript/);
assert.match(frontend,/console:refreshConsoleConnection/);
const parser=require('../../native/mgu-ai-agent/console-readonly.js');
assert.deepEqual(parser.tokens('grep -niE "audio|CarPlay" /etc/cinemo/cinemo_options.xml'),['grep','-niE','audio|CarPlay','/etc/cinemo/cinemo_options.xml']);
assert.throws(()=>parser.tokens('for x in aplay ffmpeg; do command -v "$x"; done'),/Shell operators not allowed/);
assert.throws(()=>parser.tokens('ls /etc/cinemo | grep audio'),/Shell operators not allowed/);
const {route}=require('../server.js');
(async()=>{
 const server=http.createServer(route);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 try{
  const unauth=await fetch(base+'/api/v1/jobs',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(unauth.status,401);
  const headers={authorization:'Bearer '+token,'content-type':'application/json'};
  const created=await fetch(base+'/api/v1/jobs',{method:'POST',headers,body:JSON.stringify({
   type:'console',payload:{command:'ls /etc/cinemo'},reason:'Test command'
  })});
  assert.equal(created.status,201);
  const job=(await created.json()).job;
  assert.equal(job.status,'pending','commands must never execute on form submit');
  const denied=await fetch(base+'/api/v1/jobs/'+job.id+'/reject',{method:'POST',headers});
  assert.equal(denied.status,200);
  assert.equal((await denied.json()).job.status,'rejected');
  console.log('BMW AI mobile console: UI, history, quote-aware safety, authentication and one-time approval passed.');
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
