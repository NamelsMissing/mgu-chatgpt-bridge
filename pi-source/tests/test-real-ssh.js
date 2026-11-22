'use strict';
// Requires an isolated SSH test account with /usr/bin/node and a writable /tmp.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const http=require('node:http');
const os=require('node:os');
const path=require('node:path');
const ssh=require('../mgu-ssh');
assert.ok(ssh.configured(),'Set MGU_SSH_TARGET for the isolated test server');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bmw-ai-real-ssh-'));
const remote='/tmp/bmw-ai-test-'+crypto.randomUUID();
const secret=crypto.randomBytes(32).toString('base64url');
const digest=crypto.createHash('sha256').update(secret).digest('hex');
process.env.LOGIN_PASSWORD='isolated-local-test-password';
process.env.DATA_DIR=temp;
fs.writeFileSync(path.join(temp,'state.json'),JSON.stringify({sessions:{[digest]:{expires:new Date(Date.now()+600000).toISOString()}}}));
const {route}=require('../server');
const server=http.createServer(route);

(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 function api(url,method='GET',body,authenticated=true){
  const headers={'content-type':'application/json'};
  if(authenticated)headers.authorization='Bearer '+secret;
  return fetch(origin+url,{method,headers,body:body&&JSON.stringify(body)});
 }
 const call=(endpoint,method,body,authenticated)=>api('/api/v1'+endpoint,method,body,authenticated);
 const commandPath='/console/expert/run';
 const command=cmd=>call(commandPath,'POST',{command:cmd,confirmed:true});
 try{
  assert.equal((await call(commandPath,'POST',{command:'true',confirmed:true},false)).status,401);
  assert.equal((await command('true')).status,403);
  assert.equal((await call('/console/expert','POST',{enabled:true,password:process.env.LOGIN_PASSWORD})).status,200);
  assert.equal((await call(commandPath,'POST',{command:'true'})).status,403);
  const setup=await command(`mkdir -p "${remote}/sub"
printf "test" > "${remote}/sub/test.txt"
printf '{"ok":true}' > "${remote}/test.json"
printf '\\000\\177\\377' > "${remote}/test.bin"
dd if=/dev/zero of="${remote}/large.bin" bs=1M count=20 2>/dev/null
mkdir "${remote}/private"
chmod 000 "${remote}/private"
find "${remote}" -name '*.txt' -print -exec cat {} \\; 2>/dev/null
printf '%s' "${remote}" | wc -c
printf 'stderr test' >&2
exit 7`);
  const result=await setup.json();
  assert.equal(result.exitCode,7);
  assert.match(result.stdout,/test\.txt\ntest/);
  assert.equal(result.stderr,'stderr test');

  const running=command('sleep 12; touch '+remote+'/aborted');
  await new Promise(resolve=>setTimeout(resolve,800));
  assert.equal((await call('/console/expert/abort','POST')).status,200);
  assert.equal((await (await running).json()).cancelled,true);
  assert.equal((await (await command('test ! -e '+remote+'/aborted')).json()).exitCode,0);

  const browsing=async (p,extra={})=>call('/mgu/browse','POST',{path:p,...extra});
  assert.equal((await browsing(remote+'/missing')).status,404);
  assert.equal((await browsing(remote+'/private')).status,403);
  const tree=await (await browsing(remote,{term:'.txt',recursive:true})).json();
  assert.equal(tree.entries[0].name,'sub/test.txt');
  assert.ok(tree.entries[0].mtime);
  assert.equal((await (await browsing(remote+'/sub')).json()).entries[0].bytes,4);

  const created=await (await call('/mgu/favorites','POST',{path:remote,name:'Test'})).json();
  const id=created.favorites[0].id;
  await call('/mgu/favorites','POST',{id,name:'Umbenannt'});
  const persisted=JSON.parse(fs.readFileSync(path.join(temp,'state.json'),'utf8')).mguFavorites;
  assert.deepEqual(persisted,[{id,path:remote,name:'Umbenannt'}]);
  assert.deepEqual((await (await call('/mgu/favorites','DELETE',{id})).json()).favorites,[]);

  const examples={'sub/test.txt':Buffer.from('test'),'test.json':Buffer.from('{"ok":true}'),'test.bin':Buffer.from([0,127,255])};
  for(const [name,expected] of Object.entries(examples)){
   const uri='/mgu/download?path='+encodeURIComponent(remote+'/'+name);
   assert.equal((await call(uri,'GET',null,false)).status,401);
   const res=await call(uri);
   assert.equal(res.status,200);
   assert.ok(res.headers.get('content-disposition').endsWith(path.basename(name)));
   assert.deepEqual(Buffer.from(await res.arrayBuffer()),expected);
  }
  const saved=await (await call('/mgu/fetch','POST',{path:remote+'/test.bin'})).json();
  assert.equal(saved.file.bytes,3);
  const ticket=await (await call('/mgu/download-ticket','POST',{path:remote+'/large.bin'})).json();
  const large=await api(ticket.url,'GET',null,false);
  assert.equal(large.status,200);
  assert.equal(Buffer.from(await large.arrayBuffer()).length,20*1024*1024);
  assert.equal((await api(ticket.url,'GET',null,false)).status,403);
  const interrupt=new AbortController();
  const partial=await fetch(origin+'/api/v1/mgu/download?path='+encodeURIComponent(remote+'/large.bin'),{
   headers:{authorization:'Bearer '+secret},signal:interrupt.signal
  });
  const reader=partial.body.getReader();
  assert.ok((await reader.read()).value.length>0);
  interrupt.abort();
  await assert.rejects(async()=>{while(!(await reader.read()).done){}},/abort/i);
  const afterDisconnect=await call('/mgu/download?path='+encodeURIComponent(remote+'/test.bin'));
  assert.deepEqual(Buffer.from(await afterDisconnect.arrayBuffer()),examples['test.bin']);
  const timeout=await (await command('sleep 60')).json();
  assert.equal(timeout.timedOut,true);
  assert.equal(timeout.exitCode,124);
  console.log('Real OpenSSH: authorization, shell syntax, exit, timeout, cancellation, browse, favorites and exact file transfer passed.');
 }finally{
  await ssh.runCommand('chmod 700 '+remote+'/private; rm -rf '+remote);
  await new Promise(resolve=>server.close(resolve));
  fs.rmSync(temp,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
