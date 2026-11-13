'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const http=require('node:http');
const os=require('node:os');
const path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bmw-auto-update-prefs-'));
process.env.LOGIN_PASSWORD='test-only-secure-password-not-used-in-production';
process.env.DATA_DIR=temp;
process.env.HOST='127.0.0.1';
process.env.BMW_AI_UPDATE_ROOT=path.join(temp,'updater');
fs.mkdirSync(process.env.BMW_AI_UPDATE_ROOT);
const session=crypto.randomBytes(32).toString('base64url');
const sessions={};
sessions[crypto.createHash('sha256').update(session).digest('hex')]={expires:new Date(Date.now()+3600000).toISOString()};
fs.writeFileSync(path.join(temp,'state.json'),JSON.stringify({sessions,conversations:{},messages:{},jobs:{},reports:{},files:{},logs:[]}));
const frontend=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
assert.match(frontend,/updates:refreshUpdates/,'opening the Updates tab must load stored settings');
assert.match(frontend,/autoSettingsError/,'frontend must recognize unreadable settings');
assert.match(html,/id="autoUpdate" disabled/,'checkbox must not look off while loading');
const {route}=require('../server.js');
(async()=>{
 const server=http.createServer(route);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port,headers={authorization:'Bearer '+session,'content-type':'application/json'};
 try{
  const get=async()=>{const r=await fetch(base+'/api/v1/updates',{headers});assert.equal(r.status,200);return r.json();};
  let d=await get();assert.equal(d.auto,false);assert.equal(d.autoSettingsError,false);
  const post=await fetch(base+'/api/v1/updates/automatic',{method:'POST',headers,body:JSON.stringify({enabled:true})});
  assert.equal(post.status,200);assert.equal((await post.json()).auto,true);
  const prefs=path.join(process.env.BMW_AI_UPDATE_ROOT,'prefs.json');
  const persisted=JSON.parse(fs.readFileSync(prefs,'utf8'));
  assert.equal(persisted.auto,true,'auto:true must be persisted as a file');
  // Repeated page reads must not change the option.
  d=await get();assert.equal(d.auto,true);assert.equal(d.autoSettingsError,false);
  d=await get();assert.equal(d.auto,true);
  fs.writeFileSync(prefs,'invalid-json');
  d=await get();assert.equal(d.autoSettingsError,true,'invalid prefs should be flagged, not reported as deliberate off');
  console.log('BMW AI auto-update settings tests passed: persistence, reopen UI state, corrupt preferences.');
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
