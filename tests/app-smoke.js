'use strict';
const vm=require('vm'),fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..'),spec=JSON.parse(fs.readFileSync(path.join(root,'apps/mgu_chatgpt_bridge/app.json')));
let definition,loop,events={},texts=[],writes=[];
const cv=new Proxy({},{get:(_,name)=>name==='text'?(s)=>texts.push(s):()=>{}});
let file={updatedAt:Date.now(),enabled:true,paired:true,server:'https://bridge.example.com',deviceId:'vehicle',allowShell:false,lastContact:Date.now(),outbox:0};
const ctx={dataDir:'/app/data',ui:{onClick:(name,fn)=>{events[name]=fn;},image:async()=>{}},loop:(_,rate,fn)=>{loop=fn;},canvas:()=>cv,log:{warn:()=>{}}};
const code=fs.readFileSync(path.join(root,'apps/mgu_chatgpt_bridge/main.js'),'utf8');
vm.runInNewContext(code,{require:name=>name==='./kit/mgu'?{run:d=>{definition=d;}}:name==='fs'?{readFileSync:()=>{if(file===null)throw Error('Missing');return JSON.stringify(file);},writeFileSync:(p,b)=>writes.push(JSON.parse(b))}:name==='path'?path:name==='./qr'?require('../apps/mgu_chatgpt_bridge/qr'):require(name),Date,console});
(async()=>{
 await definition.start(ctx);assert.deepEqual(Object.keys(events).sort(),spec.screens[0].buttons.map(b=>b[0]).sort());
 await loop();assert.ok(texts.includes('BRIDGE ENABLED'));
 texts=[];file.enabled=false;await loop();assert.ok(texts.includes('PAUSED'));
 texts=[];file=null;await loop();assert.ok(texts.includes('SERVICE OFFLINE'));
 events.BTN_PAUSE();assert.equal(writes.pop().action,'pause');events.BTN_RESUME();assert.equal(writes.pop().action,'resume');
 console.log('PASS: 6 ID7 app checks (buttons, enabled/paused/offline rendering, pause/resume requests).');
})().catch(e=>{console.error(e);process.exitCode=1;});
