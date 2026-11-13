'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const http=require('node:http');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bmw-ai-refresh-'));
process.env.LOGIN_PASSWORD='test-only-unique-password-for-unit-tests';
process.env.DATA_DIR=temp;
process.env.HOST='127.0.0.1';
process.env.BMW_AI_UPDATE_ROOT=path.join(temp,'updater');
const {route}=require('../server.js');
(async()=>{
 const version=fs.readFileSync(path.join(__dirname,'../VERSION'),'utf8').trim();
 const server=http.createServer(route);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const host='http://127.0.0.1:'+server.address().port;
 try{
  const health=await fetch(host+'/health',{cache:'no-store'});
  assert.equal(health.status,200);
  assert.equal((await health.json()).version,version);
  const index=await fetch(host+'/',{cache:'no-store'});
  assert.equal(index.status,200);
  assert.match(index.headers.get('cache-control')||'',/no-store/);
  assert.match(await index.text(),new RegExp('<meta name="bmw-ai-version" content="'+version.replace(/\./g,'\\.')+'">'));
  const js=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  assert.match(js,/fetch\('\/health',[^\n]*cache:'no-store'/);
  assert.match(js,/visibilitychange/);
  assert.match(js,/setInterval\(bmaiCheckServerBuild,15000\)/);
  assert.match(js,/bmaiHasUnsavedWork\(\)/);
  assert.match(js,/bmw-ai-resume-conversation/);
  assert.match(html,/id="newVersionNotice" hidden/);
  assert.match(html,/id="reloadNewVersion"/);
  assert.match(js,/sessionStorage\.getItem\(BMAI_AUTO_RELOADED_KEY\)===bmaiPendingVersion/);
  console.log('BMW AI web refresh test passed: uncached health, per-load build, no-store HTML, draft protection, reload loop guard.');
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
