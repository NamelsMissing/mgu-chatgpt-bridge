'use strict';
// Rauchtest der App BMW AI Bridge (ID7): Tasten, Anzeige je Einrichtungsschritt, Anfragen an den Agenten.
const vm=require('vm'),fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..'),spec=JSON.parse(fs.readFileSync(path.join(root,'apps/mgu_chatgpt_bridge/app.json')));
let definition,loop,events={},texts=[],writes=[],qrDrawn=0;
const cv=new Proxy({},{get:(_,name)=>name==='text'?(s)=>texts.push(s):name==='fillRect'?()=>qrDrawn++:()=>{}});
let status=null;
const ctx={dataDir:'/app/data',ui:{onClick:(name,fn)=>{events[name]=fn;},image:async()=>{}},loop:(_,rate,fn)=>{loop=fn;},canvas:()=>cv,log:{warn:()=>{}}};
const fakeFs={
 readFileSync:p=>{assert.equal(p,'/app/data/bmw-ai-status.json');if(status===null)throw Error('ENOENT');return JSON.stringify(status);},
 writeFileSync:(p,b)=>{assert.equal(p,'/app/data/bmw-ai-request.json');writes.push(JSON.parse(b));}
};
const code=fs.readFileSync(path.join(root,'apps/mgu_chatgpt_bridge/main.js'),'utf8');
vm.runInNewContext(code,{require:name=>name==='./kit/mgu'?{run:d=>{definition=d;}}:name==='fs'?fakeFs:name==='path'?path:name==='./qr'?require('../apps/mgu_chatgpt_bridge/qr'):require(name),Date,console});
const render=async s=>{status=s;texts=[];qrDrawn=0;await loop();return texts;};
const fresh=extra=>Object.assign({at:new Date().toISOString(),tailscale:{installed:true,connected:true,tailIP:'100.64.0.7'},paired:true},extra);
(async()=>{
 await definition.start(ctx);
 assert.deepEqual(Object.keys(events).sort(),spec.screens[0].buttons.map(b=>b[0]).sort(),'jede Taste aus app.json hat einen Handler');
 assert.ok((await render(null)).includes('DIENST NICHT ERREICHBAR'));
 assert.ok(texts.includes('BMW AI Companion Agent nicht aktiv'));
 assert.ok((await render(fresh({tailscale:{installed:false}}))).includes('NETZWERKTOOL FEHLT'));
 assert.ok((await render(fresh({tailscale:{installed:true,connected:false,loginUrl:'https://login.tailscale.com/a/abc123'}}))).includes('SCHRITT 1: TAILSCALE'));
 assert.ok(qrDrawn>100,'Tailscale-QR wird gezeichnet');
 assert.ok((await render(fresh({paired:false,pairing:{pairUrl:'http://100.65.28.85:8790/pair#x'}}))).includes('SCHRITT 2: RASPBERRY PI'));
 assert.ok(qrDrawn>100,'Kopplungs-QR wird gezeichnet');
 const ok=await render(fresh({lastDiagnostic:{preset:'system'}}));
 assert.ok(ok.includes('BMW AI VERBUNDEN'));assert.ok(ok.includes('Tailscale: Verbunden: 100.64.0.7'));assert.ok(ok.includes('Letzte Systemdiagnose: system'));
 assert.equal(qrDrawn,0,'verbunden: kein QR');
 assert.ok((await render(fresh({at:new Date(Date.now()-60000).toISOString()}))).includes('Hintergrunddienst antwortet nicht'));
 events.BTN_TS();assert.deepEqual(writes.pop(),{action:'network-connect'});
 events.BTN_PAIR();assert.deepEqual(writes.pop(),{action:'pair'});
 events.BTN_SYSTEM();assert.deepEqual(writes.pop(),{action:'diagnostic',preset:'system'});
 events.BTN_CONSOLE();assert.deepEqual(writes.pop(),{action:'console-link'});
 assert.ok((await render(fresh({webConsoleUrl:'http://100.65.28.85:8790/#console'}))).includes('HANDY-KONSOLE'));
 assert.ok(qrDrawn>100,'Konsolen-QR wird gezeichnet');
 for(const t of texts)assert.ok(/^[\x20-\x7e]*$/.test(t),'Kit-Schrift kann nur ASCII: '+t);
 console.log('PASS: BMW AI Bridge app (Tasten, 6 Anzeigezustaende, QR-Codes, Anfragen an den Agenten, ASCII-Texte).');
})().catch(e=>{console.error(e);process.exitCode=1;});
