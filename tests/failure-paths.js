'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {createBroker}=require('../broker/server'),{createAgent}=require('../agent/agent'),executor=require('../agent/executor');
async function main(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mgu-bridge-failure-')),app=createBroker({dataDir:path.join(dir,'broker')});
 const handler=app.server.listeners('request')[0];app.server.removeAllListeners('request');let rejectResult=true,tamper=false;
 app.server.on('request',(req,res)=>{
  if(req.url==='/device/result'&&rejectResult){res.writeHead(503,{'content-type':'application/json'});return res.end(JSON.stringify({error:'Simulated connection failure'}));}
  if(req.url==='/device/poll'&&tamper){const end=res.end.bind(res);res.end=function(data){let x=JSON.parse(data);if(x.job)x.job.operation={type:'shell',command:'touch '+path.join(dir,'forbidden')};return end(JSON.stringify(x));};}
  return handler(req,res);
 });
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 const deviceId='test-device',deviceKey='a'.repeat(64);app.state.devices[deviceId]={id:deviceId,key:deviceKey,label:'Failure test'};app.save();
 const file=path.join(dir,'config.json'),data=path.join(dir,'agent');fs.mkdirSync(data);fs.writeFileSync(file,JSON.stringify({server:base,deviceId,deviceKey,enabled:true,allowShell:true,dataDir:data,allowedReadRoots:[dir]}));
 let agent=createAgent(file,{directTransport:true}),checks=0;function check(v,label){assert.ok(v,label);checks++;}
 try{
  const counter=path.join(dir,'counter'),j=app.propose(deviceId,{type:'shell',command:'printf x >> '+counter},'Result retry test');app.approve(j.id,j.hash);await agent.tick();
  check(fs.readFileSync(counter,'utf8')==='x','First execution happens once');check(agent.status().outbox===1,'Failed result persisted');
  agent.stop();rejectResult=false;agent=createAgent(file,{directTransport:true});await agent.tick();
  check(fs.readFileSync(counter,'utf8')==='x','Restart and retry do not rerun shell');check(app.state.jobs[j.id].status==='done'&&agent.status().outbox===0,'Saved result delivered after restart');
  const corrupt=app.propose(deviceId,{type:'catalog',name:'system'},'Tamper test');app.approve(corrupt.id,corrupt.hash);tamper=true;await agent.tick();
  check(/Invalid/.test(agent.status().lastError),'Tampered grant rejected');check(!fs.existsSync(path.join(dir,'forbidden')),'Tampered command not executed');
  check(!JSON.parse(fs.readFileSync(path.join(data,'execution.json'))).seen[corrupt.id],'Invalid grant never recorded as executable');
  const config={allowShell:true,dataDir:data,allowedReadRoots:[dir]};
  const output=await executor.execute({type:'shell',command:'head -c 300000 /dev/zero'},config,{child:null});
  check(output.truncated&&Buffer.byteLength(output.stdout)<=32768,'Command output bounded');
  const timeout=await executor.execute({type:'shell',command:'sleep 30'},config,{child:null});
  check(timeout.timedOut&&timeout.signal==='SIGKILL','Timeout kills process group');
  console.log('PASS: '+checks+' failure-path checks (retry after restart, tampering, output limit, timeout).');
 }finally{agent.stop();await new Promise(r=>app.server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
