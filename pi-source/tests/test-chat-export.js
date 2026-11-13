'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bmw-chat-export-'));
process.env.LOGIN_PASSWORD='test-only-unique-password-should-not-be-used';
process.env.DATA_DIR=temp;
process.env.HOST='127.0.0.1';
process.env.BMW_AI_UPDATE_ROOT=path.join(temp,'updater');
const id1=crypto.randomUUID(),id2=crypto.randomUUID(),m1=crypto.randomUUID(),m2=crypto.randomUUID(),m3=crypto.randomUUID();
const token=crypto.randomBytes(32).toString('base64url');
const sessions={};
sessions[crypto.createHash('sha256').update(token).digest('hex')]={expires:new Date(Date.now()+600000).toISOString()};
fs.writeFileSync(path.join(temp,'state.json'),JSON.stringify({
 sessions,conversations:{
  [id1]:{id:id1,title:'MGU DSP Test',importSource:'ChatGPT',importedFrom:'old-id',createdAt:'2026-01-01T00:00:00Z'},
  [id2]:{id:id2,title:'Ambient Test',createdAt:'2026-01-02T00:00:00Z'}},
 messages:{
  [m1]:{id:m1,conversationId:id1,role:'user',content:'OLD CHATGPT CONTENT',createdAt:'2026-01-01T00:00:00Z',imported:true},
  [m2]:{id:m2,conversationId:id1,role:'assistant',content:'NEW PI RESPONSE',createdAt:'2026-01-03T00:00:00Z'},
  [m3]:{id:m3,conversationId:id2,role:'user',content:'LOCALLY CREATED CONTENT',createdAt:'2026-01-04T00:00:00Z'}},
 jobs:{},reports:{},files:{},logs:[]}));
const {route,exportChatDocument}=require('../server.js');
(async()=>{
 const content=exportChatDocument([id1],'new','markdown');
 assert.match(content,/NEW PI RESPONSE/);
 assert.doesNotMatch(content,/OLD CHATGPT CONTENT/);
 const full=exportChatDocument([id1],'full','markdown');
 assert.match(full,/OLD CHATGPT CONTENT/);
 const parsed=JSON.parse(exportChatDocument([id1,id2],'new','json'));
 assert.equal(parsed.schema,1);
 assert.equal(parsed.conversations.length,2);
 assert.equal(parsed.conversations[0].messages.length,1);
 assert.equal(parsed.conversations[0].messages[0].content,'NEW PI RESPONSE');
 assert.throws(()=>exportChatDocument(['not-a-uuid'],'full','markdown'));
 const server=http.createServer(route);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 try{
  const denied=await fetch(base+'/api/v1/conversations/export',{method:'POST',body:'{}'});
  assert.equal(denied.status,401);
  const response=await fetch(base+'/api/v1/conversations/export',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({ids:[id1],scope:'new',format:'markdown'})});
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-disposition'),/attachment/);
  assert.match(await response.text(),/NEW PI RESPONSE/);
  const toggle=await fetch(base+'/api/v1/conversations/export/automatic',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({enabled:true})});
  assert.equal(toggle.status,200);
  await new Promise(resolve=>setTimeout(resolve,2900));
  const snapshot=await fetch(base+'/api/v1/conversations/export/latest',{headers:{authorization:'Bearer '+token}});
  assert.equal(snapshot.status,200);
  const snap=await snapshot.text();
  assert.match(snap,/NEW PI RESPONSE/);
  assert.doesNotMatch(snap,/OLD CHATGPT CONTENT/);
  assert.equal(fs.statSync(path.join(temp,'chat-export-latest.md')).mode&0o777,0o600);
  console.log('BMW AI chat export tests passed: privacy, delta/full, JSON, auth, local snapshot.');
 }finally{await new Promise(resolve=>server.close(resolve));}
})().then(()=>fs.rmSync(temp,{recursive:true,force:true})).catch(e=>{console.error(e);process.exitCode=1;});
