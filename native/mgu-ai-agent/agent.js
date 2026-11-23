'use strict';
// BMW MGU ID7 Companion Agent. Compatible with Node 8.7 syntax.
// Strictly read-only diagnostics/files; actual vehicle control requires verified adapter and is disabled.
var http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),cp=require('child_process');
var readOnlyConsole=require('./console-readonly');
var ROOT='/var/opt/mgu-ai-agent',CONFIG=process.env.MGU_AI_CONFIG||ROOT+'/config.json';
var DATA=process.env.MGU_AI_DATA||ROOT+'/data';
var PORT=Number(process.env.MGU_AI_PORT||18766);
var ALLOWED=['/etc/cinemo','/etc/oap','/usr/lib/oap-mainapp','/var/log'];
// Vehicle values come only from the read-only "Vehicle Data" app (mgu-apps), which writes this
// file into its own data directory. Nothing is simulated; without the file, vehicle data is unavailable.
var OAP_APPS=process.env.MGU_AI_OAP_APPS||'/var/opt/public/oap',VEHICLE_FILE='bmw-vehicle-data.json';
var VEHICLE_STALE_MS=90000;
function vehicleSnapshot(){
 var dirs,best=null,installed=false,problem=null;
 try{dirs=fs.readdirSync(OAP_APPS);}catch(e){return {state:'storage_unavailable',reason:'OAP-Verzeichnis: '+e.code};}
 dirs.forEach(function(d){
  if(!/^oap_\d+$/.test(d))return;
  var root=path.join(OAP_APPS,d),dir=path.join(root,'data'),file=path.join(dir,VEHICLE_FILE);
  try{if(JSON.parse(fs.readFileSync(path.join(root,'source/package.json'),'utf8')).name==='vehicle_data')installed=true;}catch(e){}
  try{
   var st=fs.statSync(file);
   if(!st.isFile()||st.size>=1024*1024){problem='Vehicle Data file unreadable (type or size)';return;}
   var doc=JSON.parse(fs.readFileSync(file,'utf8'));
   if(!doc||doc.schema!==1||doc.app!=='vehicle_data'){problem='Unknown Vehicle Data format';return;}
   if(!best||st.mtimeMs>best.mtime)best={dir:dir,mtime:st.mtimeMs,doc:doc,appId:d};
  }catch(e){if(e.code!=='ENOENT')problem='Vehicle Data file unreadable'+(e.code?' ('+e.code+')':'');}
 });
 if(!best)return {state:problem?'snapshot_error':installed?'no_snapshot':'not_detected',
  reason:problem||(installed?'Vehicle Data installiert, aber noch kein Snapshot verfügbar':'Vehicle Data im OAP-Verzeichnis nicht gefunden')};
 var beat=Date.parse(best.doc.heartbeatAt);
 best.state=!Number.isFinite(beat)?'unknown':Math.abs(Date.now()-beat)>VEHICLE_STALE_MS?'stale':'running';
 return best;
}
function vehicleData(best){
 best=best||vehicleSnapshot();
 if(!best.doc)return {status:'unavailable',appState:best.state,reason:best.reason};
 var doc=best.doc;
 var array=function(v){return Array.isArray(v)?v:[];};
 var m=doc.mileage,km=m&&Number.isInteger(m.km)&&m.km>0&&m.km<2000000?m.km:null;
 return {status:km!==null||array(doc.cbs).length||doc.serviceHistory||doc.dpf||doc.tyres||doc.faultMemory||doc.checkControl&&doc.checkControl.listAt?'ok':'waiting',appState:best.state,appId:best.appId,heartbeatAt:doc.heartbeatAt||null,source:'Vehicle Data '+(doc.version||''),writtenAt:doc.writtenAt||null,
  mileageKm:km,mileageAt:m?m.at:null,mileageSource:m?m.source:null,unverified:true,
  cbs:Array.isArray(doc.cbs)?doc.cbs.slice(0,50).filter(Boolean).map(function(c){var item={scope:c.scope,label:c.label,remainingKm:c.remainingKm,dueDate:c.dueDate,status:c.status,at:c.at};
    ['dueMonth','source','remainingAt','remainingSource','available'].forEach(function(key){if(c[key]!==undefined)item[key]=c[key];});
    return item;}):[],
  serviceHistory:doc.serviceHistory?{status:doc.serviceHistory.status,readAt:doc.serviceHistory.readAt,sets:array(doc.serviceHistory.sets).slice(0,60)}:null,
  signals:doc.signals||{},telemetry:doc.telemetry?Object.assign({},doc.telemetry,{forwardedAt:new Date().toISOString(),snapshotAt:doc.writtenAt||null}):null,
  checkControl:doc.checkControl&&typeof doc.checkControl==='object'?{listAt:doc.checkControl.listAt||null,source:doc.checkControl.source||null,active:array(doc.checkControl.active).slice(0,120),events:array(doc.checkControl.events).slice(-50)}:null,
  tyres:doc.tyres&&Array.isArray(doc.tyres.wheels)?{at:doc.tyres.at,wheels:doc.tyres.wheels.slice(0,5).map(function(w){return {position:w.position,pressureBar:w.pressureBar,targetBar:w.targetBar,temperatureC:w.temperatureC,battery:w.battery};}),unverified:true}:null,
  faultMemory:doc.faultMemory&&typeof doc.faultMemory==='object'?{requestId:doc.faultMemory.requestId,readAt:doc.faultMemory.readAt,error:doc.faultMemory.error,ecus:array(doc.faultMemory.ecus).slice(0,120),dtcs:array(doc.faultMemory.dtcs).slice(0,600)}:null,
  dpf:doc.dpf&&typeof doc.dpf==='object'?doc.dpf:null};
}
// Ask the Vehicle Data app for a fresh fault-memory read (UDS 0x19, read-only) and wait for it.
var faultReadPending=false;
function readFaultMemory(cb){
 var best=vehicleSnapshot();
 if(!best.doc||best.state==='stale')return cb({status:503,body:{code:best.state,error:best.reason||'Vehicle Data meldet keinen aktuellen Heartbeat'}});
 if(faultReadPending)return cb({status:409,body:{code:'busy',error:'Eine Fehlerspeicherabfrage läuft bereits'}});
 var id=crypto.randomBytes(12).toString('hex'),req=path.join(best.dir,'bmw-vehicle-request.json'),tmp=req+'.'+id,tries=0;
 try{
  fs.writeFileSync(tmp,JSON.stringify({id:id,type:'faultMemory',at:new Date().toISOString()}),{mode:420,flag:'wx'});
  fs.renameSync(tmp,req);
 }catch(e){
  try{fs.unlinkSync(tmp);}catch(ignore){}
  return cb({status:502,body:{code:'request_ipc',error:'Vehicle Data IPC: '+(e.code||'write failed')}});
 }
 faultReadPending=true;
 var t=setInterval(function(){
  tries++;
  var current=vehicleSnapshot(),fm=vehicleData(current).faultMemory;
  if(current.state==='stale')return finish({status:503,body:{code:'stale',error:'Vehicle Data hat während der Diagnose aufgehört zu antworten'}});
  if(fm&&fm.requestId===id)return finish({status:fm.error?502:200,body:{error:fm.error||null,faultMemory:fm}});
  if(tries>=90)finish({status:504,body:{code:'diagnostic_timeout',error:'Vehicle Data hat innerhalb von 90 s nicht geantwortet'}});
 },1000);
 function finish(result){clearInterval(t);faultReadPending=false;cb(result);}
}
var PRESETS=['system','network','audio','services','storage','bridge','recent_logs','vehicle'];
function mkdir(d){if(!fs.existsSync(d))fs.mkdirSync(d,0o700);}
function init(silent){mkdir(ROOT);mkdir(DATA);if(fs.existsSync(CONFIG))throw Error('Configuration already exists; will not replace secret');var token=crypto.randomBytes(32).toString('hex');fs.writeFileSync(CONFIG,JSON.stringify({token:token,enabled:true,allowActions:false,piOrigin:''},null,2)+'\n',{mode:0o600});fs.chmodSync(CONFIG,0o600);if(!silent)console.log('MGU token created. Copy securely to the Pi MGU_TOKEN setting: '+token);}
function cfg(){var c=JSON.parse(fs.readFileSync(CONFIG,'utf8'));if(!c.token||c.token.length<32||!c.enabled)throw Error('Agent disabled/missing token');return c;}
function constantEq(a,b){var aa=Buffer.from(String(a)),bb=Buffer.from(String(b));return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb);}
function json(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));}
function read(req){return new Promise(function(resolve,reject){var arr=[],n=0;req.on('data',function(b){n+=b.length;if(n>32768){reject(Error('Too large'));req.destroy();}else arr.push(b);});req.on('end',function(){try{resolve(JSON.parse(Buffer.concat(arr).toString('utf8')||'{}'));}catch(e){reject(Error('Invalid JSON'));}});req.on('error',reject);});}
function run(bin,args){try{return cp.execFileSync(bin,args,{timeout:5000,encoding:'utf8',maxBuffer:50000}).slice(0,40000);}catch(e){return '[not available] '+String(e.message).slice(0,220);}}
function first(arr){for(var i=0;i<arr.length;i++)if(fs.existsSync(arr[i]))return arr[i];return arr[0];}
function bridgeInfo(){var p='/var/opt/mgu-chatgpt-bridge/config.json';return {existingBridgeInstalled:fs.existsSync('/var/opt/mgu-chatgpt-bridge'),bridgeService:run(first(['/bin/systemctl','/usr/bin/systemctl']),['is-active','mgu-chatgpt-bridge.service']).trim(),note:'Bridge secrets are never read or exposed'};}
function diag(preset){if(PRESETS.indexOf(preset)<0)throw Error('Unknown preset');var x={preset:preset,at:new Date().toISOString(),source:'MGU system command (not necessarily ECU value)',values:{}};switch(preset){
case 'system':x.values.uname=run('/bin/uname',['-a']);x.values.uptime=run(first(['/usr/bin/uptime','/bin/uptime']),[]);break;
case 'network':x.values.ipv4=run(first(['/sbin/ip','/usr/sbin/ip','/bin/ip']),['-4','addr']);x.values.routes=run(first(['/sbin/ip','/usr/sbin/ip','/bin/ip']),['-4','route']);break;
case 'audio':x.values.devices=run(first(['/usr/bin/aplay','/bin/aplay']),['-l']);x.values.pcm=run(first(['/usr/bin/aplay','/bin/aplay']),['-L']);break;
case 'services':x.values.failed=run('/bin/systemctl',['--failed','--no-pager','--plain']);break;
case 'storage':x.values.df=run('/bin/df',['-h']);break;
case 'bridge':x.values=bridgeInfo();break;
case 'recent_logs':x.values.log=run(first(['/bin/journalctl','/usr/bin/journalctl']),['--no-pager','-n','70','-u','mgu-ai-agent.service']);break;
case 'vehicle':x.values=vehicleData();break;
}return x;}
function pathAllowed(input){if(typeof input!=='string'||input.length>300||input[0]!=='/'||input.indexOf('\0')!==-1)throw Error('Invalid absolute path');
var full=path.resolve(input),real=fs.realpathSync(full);if(!ALLOWED.some(function(base){return real===base||real.indexOf(base+'/')===0;}))throw Error('Path outside read-only allowlist');
// Deny symlink in any interior path segment as defense in depth.
var parts=full.split('/').filter(Boolean),p='';parts.forEach(function(seg){p+='/'+seg;if(fs.lstatSync(p).isSymbolicLink())throw Error('Symlink traversal denied');});
return real;}
function listFiles(p){var real=pathAllowed(p),s=fs.statSync(real);if(!s.isDirectory())throw Error('Not a directory');return {path:real,entries:fs.readdirSync(real).slice(0,200).map(function(name){try{var stat=fs.lstatSync(path.join(real,name));return {name:name,kind:stat.isSymbolicLink()?'symlink':stat.isDirectory()?'directory':'file',bytes:stat.size};}catch(e){return {name:name,kind:'unavailable'};}})};}
function fileContents(p){var real=pathAllowed(p),fd=fs.openSync(real,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{var s=fs.fstatSync(fd);if(!s.isFile()||s.size>8*1024*1024)throw Error('Only regular files up to 8 MiB');var b=Buffer.alloc(s.size),got=0;while(got<b.length){var n=fs.readSync(fd,b,got,b.length-got,got);if(!n)throw Error('File changed during read');got+=n;}return b.slice(0,got);}finally{fs.closeSync(fd);}}
var latest={at:null,message:'Bereit zur sicheren Kopplung',lastDiagnostic:null,paired:false};
var pair=null;
var tsLogin={url:'',started:0,child:null,error:''};
// Tailscale's independently installed native tool provides the encrypted transport.
// All user-facing login and pairing are controlled from this BMW AI app.
function tsBin(){return process.env.MGU_AI_TS_BIN||'/var/opt/iteriodev-tailscale/current/ts';}
function tsAvailable(){return fs.existsSync(tsBin());}
function tailIP(){
 if(!tsAvailable())return '';
 try{var out=cp.execFileSync(tsBin(),['ip','-4'],{timeout:2500,encoding:'utf8'}).trim();
   var ip=out.split(/\s+/)[0];var oct=ip.split('.').map(Number);
   if(oct.length===4&&oct[0]===100&&oct[1]>=64&&oct[1]<=127&&oct.slice(2).every(function(x){return x>=0&&x<=255;}))return ip;
 }catch(e){}return '';
}
function safeTailscaleLoginUrl(text){
 var m=String(text).match(/https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9_-]{6,256}/);
 return m?m[0]:'';
}
function connectTailscale(){
 if(!tsAvailable()){latest.message='Tailscale-Hintergrundtool fehlt. Im MGU Store unter Tools installieren (keine separate App).';return;}
 if(tailIP()){tsLogin.url='';latest.message='Tailscale bereits verbunden. Jetzt Raspberry Pi koppeln.';return;}
 if(tsLogin.child){latest.message='Tailscale-Anmeldung laeuft. QR-Code scannen.';return;}
 tsLogin.url='';tsLogin.started=Date.now();tsLogin.error='';
 latest.message='Tailscale wird gestartet. QR-Code folgt.';
 try{
  var child=cp.spawn(tsBin(),['up','--hostname=bmw-mgu'],{stdio:['ignore','pipe','pipe']});
  tsLogin.child=child;
  var outputBuffer='';
  function onOutput(chunk){
    outputBuffer=(outputBuffer+chunk.toString('utf8')).slice(-8192);
    var found=safeTailscaleLoginUrl(outputBuffer);
    if(found){tsLogin.url=found;latest.message='Tailscale-QR-Code scannen und Geraet freigeben.';emitUI();}
  }
  child.stdout.on('data',onOutput);child.stderr.on('data',onOutput);
  child.on('error',function(e){tsLogin.child=null;tsLogin.error=e.message;latest.message='Tailscale-Start fehlgeschlagen: '+String(e.message).slice(0,90);emitUI();});
  child.on('exit',function(code){if(tsLogin.child===child)tsLogin.child=null;
    if(tailIP()){tsLogin.url='';latest.message='Tailscale verbunden. Jetzt Raspberry Pi koppeln.';}
    else if(!tsLogin.url){latest.message='Tailscale-Anmeldung fehlgeschlagen (Exit '+code+'). Bitte mgu-uplink pruefen.';}
    emitUI();
  });
  setTimeout(function(){if(tsLogin.child===child){child.kill('SIGTERM');tsLogin.child=null;}tsLogin.url='';emitUI();},300000);
 }catch(e){tsLogin.child=null;latest.message='Tailscale-Start fehlgeschlagen: '+String(e.message).slice(0,90);}
}
function tsNetworkStatus(){
 var ip=tailIP();
 if(ip)tsLogin.url='';
 if(tsLogin.url&&Date.now()-tsLogin.started>300000)tsLogin.url='';
 return {installed:tsAvailable(),connected:!!ip,tailIP:ip,loginUrl:ip?'':tsLogin.url,
   error:tsLogin.error,loginRunning:!!tsLogin.child};
}
function autoPiOrigin(){
 if(!tsAvailable())return '';
 try{
  var value=JSON.parse(cp.execFileSync(tsBin(),['status','--json'],{timeout:4500,encoding:'utf8',maxBuffer:220000}));
  var peers=value.Peer||{};
  var keys=Object.keys(peers);
  for(var i=0;i<keys.length;i++){
   var peer=peers[keys[i]],host=String(peer.HostName||'').toLowerCase(),dns=String(peer.DNSName||'').replace(/\.$/,'').toLowerCase();
   if((host==='bmw-ai-pi'||dns.indexOf('bmw-ai-pi.')===0)&&/^bmw-ai-pi\.[a-z0-9.-]+\.ts\.net$/.test(dns))return 'https://'+dns;
  }
 }catch(e){}
 return '';
}
function beginPair(){
 var c=cfg(),ip=tailIP();
 if(!ip){connectTailscale();latest.message=tsLogin.url?'Zuerst den Tailscale-QR-Code scannen.':'Zuerst Netzwerk verbinden und Tailscale freigeben.';pair=null;return;}
 var origin=String(c.piOrigin||'').replace(/\/+$/,'');
 if(!origin)origin=autoPiOrigin();
 if(!/^https:\/\/[A-Za-z0-9.-]+\.ts\.net$/.test(origin)){
  latest.message='Raspberry Pi nicht im Tailnet gefunden (Geraetename bmw-ai-pi).';pair=null;return;
 }
 pair={code:crypto.randomBytes(16).toString('hex'),expires:Date.now()+120000,ip:ip,origin:origin};
 latest.message='BMW-AI-QR-Code scannen und Kopplung auf dem Pi bestaetigen.';
}
function pairingInfo(knownIP){if(pair&&Date.now()>=pair.expires)pair=null;
 if(!pair)return {pairUrl:'',pairExpiresAt:null,tailIP:typeof knownIP==='string'?knownIP:tailIP()};
 return {pairUrl:pair.origin+'/pair?ip='+encodeURIComponent(pair.ip)+'&code='+encodeURIComponent(pair.code),pairExpiresAt:new Date(pair.expires).toISOString(),tailIP:pair.ip};
}
function claimPair(code){
 if(typeof code!=='string'||!/^[0-9a-f]{32}$/.test(code)||!pair||Date.now()>=pair.expires||!constantEq(code,pair.code))return null;
 pair=null;latest.paired=true;latest.message='MGU mit dem Pi gekoppelt';emitUI();return cfg().token;
}
function appDataDirs(){var root=OAP_APPS,result=[];try{fs.readdirSync(root).forEach(function(d){if(!/^oap_\d+$/.test(d))return;var dir=path.join(root,d);try{var pkg=JSON.parse(fs.readFileSync(path.join(dir,'source/package.json'),'utf8'));if(pkg.name==='mgu_ai_assistant'||pkg.name==='mgu_chatgpt_bridge')result.push(path.join(dir,'data'));}catch(e){}});}catch(e){}return result;}
var uiBridge=null,uiBridgeAt=0;
function emitUI(){
 var dirs=appDataDirs();if(!dirs.length)return;
 var network=tsNetworkStatus();
 if(Date.now()-uiBridgeAt>=30000){uiBridge=bridgeInfo();uiBridgeAt=Date.now();}
 var value={version:'0.2.8',paired:!!latest.paired,tailscale:network,pairing:pairingInfo(network.tailIP),
  webConsoleUrl:latest.webConsoleUrl||'',at:new Date().toISOString(),lastMessage:latest.message,lastDiagnostic:latest.lastDiagnostic,
  remoteAccess:'Tailscale backend only; no separate Tailscale app is required',vehicleDataVerified:false,vehicleControlsEnabled:false,bridge:uiBridge};
 dirs.forEach(function(dir){
  try{
   var f=path.join(dir,'bmw-ai-status.json'),tmp=f+'.tmp';
   fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o644});fs.renameSync(tmp,f);
  }catch(e){}
 });
}
function localRequests(){appDataDirs().forEach(function(dir){var f=path.join(dir,'bmw-ai-request.json');try{if(!fs.existsSync(f))return;var b=fs.readFileSync(f,'utf8');fs.unlinkSync(f);if(b.length>1000)return;var d=JSON.parse(b);if(d.action==='diagnostic'&&['system','network','audio','bridge'].indexOf(d.preset)>=0){var result=diag(d.preset);latest.lastDiagnostic={preset:d.preset,at:result.at,preview:JSON.stringify(result.values).slice(0,350)};fs.writeFileSync(path.join(DATA,'last-local-diagnostic.json'),JSON.stringify(result),{mode:0o600});}if(d.action==='network-connect')connectTailscale();if(d.action==='refresh'){latest.message='Status aktualisiert';}if(d.action==='pair')beginPair();if(d.action==='console-link'){
 var origin=String(cfg().piOrigin||'').replace(/\/+$/,'')||autoPiOrigin();
 // Public QR shows only a URL. The protected terminal still requires Pi login and Tailscale.
 if(/^https:\/\/[a-z0-9.-]+\.ts\.net$/i.test(origin)){
  latest.webConsoleUrl=origin+'/#console';latest.message='Handy-Konsole: QR-Code scannen und auf dem Pi anmelden.';
 }else{latest.webConsoleUrl='';latest.message='Pi-URL nicht gefunden. MGU und Raspberry Pi im Tailscale-Netz verbinden.';}
}}catch(e){}});emitUI();}
function app(req,res){(async function(){var c=cfg(),raw=(req.headers.authorization||'').replace(/^Bearer /,'');if(req.url.split('?')[0]!=='/v1/pair/claim'&&!constantEq(raw,c.token))return json(res,401,{error:'Unauthorized'});
 var url=req.url.split('?')[0],b={};if(req.method==='POST')b=await read(req);
 if(req.method==='POST'&&url==='/v1/pair/claim'){
   var deviceToken=claimPair(b.code);
   if(!deviceToken)return json(res,403,{error:'Pairing code invalid or expired'});
   return json(res,200,{token:deviceToken});
 }
 if(req.method==='GET'&&url==='/v1/status'){latest.paired=true;var vehicle=vehicleData();return json(res,200,{online:true,at:new Date().toISOString(),host:run('/bin/uname',['-n']).trim(),vehicleDataAvailable:vehicle.appState==='running'&&vehicle.status==='ok',vehicle:vehicle,capabilities:{diagnostics:PRESETS,files:true,actions:false},latestMessage:latest.message,lastDiagnostic:latest.lastDiagnostic});}
 if(req.method==='POST'&&url==='/v1/vehicle/fault-memory')return readFaultMemory(function(r){json(res,r.status,r.body);});
 if(req.method==='POST'&&url==='/v1/console')return json(res,200,readOnlyConsole.run(b.command));
 if(req.method==='POST'&&url==='/v1/diagnostics'){var d=diag(b.preset);latest.lastDiagnostic={preset:d.preset,at:d.at,preview:JSON.stringify(d.values).slice(0,350)};emitUI();return json(res,200,d);}
 if(req.method==='POST'&&url==='/v1/files/list')return json(res,200,listFiles(b.path));
 if(req.method==='POST'&&url==='/v1/files/read'){var data=fileContents(b.path);res.writeHead(200,{'content-length':data.length,'content-type':'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff'});return res.end(data);}
 if(req.method==='POST'&&url==='/v1/notify'){latest.message=String(b.text||'').slice(0,280);latest.at=new Date().toISOString();emitUI();return json(res,200,{ok:true});}
 if(req.method==='POST'&&url==='/v1/actions')return json(res,501,{error:'Vehicle control adapter not implemented or verified. Nothing executed.',requested:b.action});
 return json(res,404,{error:'Not found'});
 })().catch(function(e){json(res,400,{error:String(e.message).slice(0,200)});});}
if(require.main===module){if(process.argv[2]==='init'){init(false);process.exit(0);}if(!fs.existsSync(CONFIG))init(true);cfg();if(!Number.isInteger(PORT)||PORT<1024||PORT>65535)throw Error('Invalid port');http.createServer(app).listen(PORT,'127.0.0.1',function(){console.log('BMW MGU companion agent listening on local loopback port '+PORT);});setInterval(localRequests,3000);localRequests();}
module.exports={vehicleData:vehicleData,readFaultMemory:readFaultMemory,diag:diag,pathAllowed:pathAllowed,app:app,beginPair:beginPair,claimPair:claimPair,pairingInfo:pairingInfo,connectTailscale:connectTailscale,autoPiOrigin:autoPiOrigin,tsNetworkStatus:tsNetworkStatus,safeTailscaleLoginUrl:safeTailscaleLoginUrl};
