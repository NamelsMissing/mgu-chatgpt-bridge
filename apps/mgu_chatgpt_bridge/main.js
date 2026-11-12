'use strict';
const mgu=require('./kit/mgu'),fs=require('fs'),path=require('path'),qr=require('./qr');
function drawQR(cv,value,x,y,size){const q=qr(0,'M');q.addData(value);q.make();const n=q.getModuleCount(),step=Math.floor(size/(n+8)),total=step*(n+8),ox=x+(size-total)/2,oy=y+(size-total)/2;cv.roundRect(x-10,y-10,size+20,size+20,12,'#ffffff');for(let r=0;r<n;r++)for(let c=0;c<n;c++)if(q.isDark(r,c))cv.fillRect(ox+(c+4)*step,oy+(r+4)*step,step,step,'#071323');}
mgu.run({async start(ctx){
 let info=null,error='';
 function reload(){try{info=JSON.parse(fs.readFileSync(path.join(ctx.dataDir,'bmw-ai-status.json'),'utf8'));error=!info.at||Date.now()-Date.parse(info.at)>12000?'Hintergrunddienst antwortet nicht':'';}catch(e){error='BMW AI Companion Agent nicht aktiv';}}
 function request(action,preset){try{fs.writeFileSync(path.join(ctx.dataDir,'bmw-ai-request.json'),JSON.stringify({action,preset}));error='';}catch(e){error=e.message;}}
 ctx.ui.onClick('BTN_TS',()=>request('network-connect'));
 ctx.ui.onClick('BTN_PAIR',()=>request('pair'));
 ctx.ui.onClick('BTN_REFRESH',reload);
 ctx.ui.onClick('BTN_SYSTEM',()=>request('diagnostic','system'));
 ctx.loop('MAIN',1,async()=>{
  reload();const cv=ctx.canvas(1600,520);cv.clear('#081320');cv.roundRect(24,20,1552,480,24,'#13253b');
  cv.text('BMW AI ASSISTANT',58,91,42,'#ecf7ff',{font:'bold'});
  cv.text('ID7 / Version 0.2.1  |  Netzwerk + Pi-Kopplung',60,131,21,'#a8c6e5');
  const ts=info&&info.tailscale||{},p=info&&info.pairing||{};
  let qrLink='',phase='',instruction='';
  if(!info){phase='DIENST NICHT ERREICHBAR';instruction='BMW AI Companion Agent aus deinem MGU Store installieren.';}
  else if(!ts.installed){phase='NETZWERKTOOL FEHLT';instruction='Nur das Tailscale-Tool unter Tools installieren, keine zweite App.';}
  else if(!ts.connected){phase='SCHRITT 1: TAILSCALE';qrLink=ts.loginUrl||'';instruction=qrLink?'Tailscale-QR-Code scannen und MGU freigeben.':'Unten NETZWERK VERBINDEN waehlen.';}
  else if(!info.paired){phase='SCHRITT 2: RASPBERRY PI';qrLink=p.pairUrl||'';instruction=qrLink?'BMW AI QR scannen und auf dem Pi bestaetigen.':'Unten MIT RASPBERRY PI KOPPELN waehlen.';}
  else {phase='BMW AI VERBUNDEN';instruction='MGU im Tailnet. Diagnose und Dateiabruf am Pi verwenden.';}
  cv.text(phase,62,190,32,info&&ts.connected?'#69e2ac':'#ffd18f',{font:'bold'});
  cv.text(('Tailscale: '+(ts.connected?'Verbunden: '+ts.tailIP:ts.installed?'Nicht verbunden':'Tool fehlt')).slice(0,85),62,241,23,'#d3e6f7');
  cv.text(instruction.slice(0,78),62,292,23,'#e7f3ff');
  if(info&&info.lastMessage)cv.text(String(info.lastMessage).slice(0,79),62,341,19,'#9dc5ef');
  if(info&&info.lastDiagnostic)cv.text('Letzte Systemdiagnose: '+info.lastDiagnostic.preset,62,385,20,'#b9d8f5');
  if(qrLink)try{drawQR(cv,qrLink,1194,113,290);}catch(e){cv.text(('QR: '+e.message).slice(0,36),1150,302,17,'#ffad83');}
  if(error)cv.text(error.slice(0,100),62,435,20,'#ffc27b');
  cv.text('Privates Tailnet. Keine Router-Portfreigabe. Keine Fahrzeugsteuerung.',62,474,19,'#86b4e4');
  return ctx.ui.image('MAIN_GFX',cv);
 });reload();
}});
