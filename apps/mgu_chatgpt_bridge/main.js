'use strict';
// Same MGU Store app ID as the previous Analysis Bridge; updated to BMW AI Companion.
const mgu=require('./kit/mgu'),fs=require('fs'),path=require('path'),qr=require('./qr');
function drawQR(cv,value,x,y,size){const q=qr(0,'M');q.addData(value);q.make();const n=q.getModuleCount(),step=Math.floor(size/(n+8));const total=step*(n+8),ox=x+(size-total)/2,oy=y+(size-total)/2;cv.roundRect(x-10,y-10,size+20,size+20,12,'#ffffff');for(let r=0;r<n;r++)for(let c=0;c<n;c++)if(q.isDark(r,c))cv.fillRect(ox+(c+4)*step,oy+(r+4)*step,step,step,'#0a1526');}
mgu.run({async start(ctx){
 let info=null,error='Waiting for BMW AI Agent';
 function reload(){try{info=JSON.parse(fs.readFileSync(path.join(ctx.dataDir,'bmw-ai-status.json'),'utf8'));error=!info.at||Date.now()-Date.parse(info.at)>12000?'Agent status outdated':'';}catch(e){error='BMW AI Companion Agent not installed or running';}}
 function request(action,preset){try{fs.writeFileSync(path.join(ctx.dataDir,'bmw-ai-request.json'),JSON.stringify({action,preset}));error='';}catch(e){error=e.message;}}
 ctx.ui.onClick('BTN_PAIR',()=>request('pair'));
 ctx.ui.onClick('BTN_REFRESH',()=>request('refresh'));
 ctx.ui.onClick('BTN_SYSTEM',()=>request('diagnostic','system'));
 ctx.ui.onClick('BTN_NETWORK',()=>request('diagnostic','network'));
 ctx.loop('MAIN',1,async()=>{
  reload();const cv=ctx.canvas(1600,520);cv.clear('#091323');cv.roundRect(24,20,1552,480,26,'#14253a');
  cv.text('BMW AI ASSISTANT',60,88,42,'#f5faff',{font:'bold'});
  cv.text('MGU ANALYSIS BRIDGE  /  ID7  /  v0.2.0',60,126,22,'#9fb8d1');
  cv.text(error?'SERVICE OFFLINE':'PI-VERBINDUNG / QR-KOPPLUNG',60,178,30,error?'#ffc887':'#62e2ae',{font:'bold'});
  if(info){
   const p=info.pairing||{};
   cv.text('MGU Tailscale IP: '+(p.tailIP||'not connected'),60,226,23,'#c4d6e9');
   cv.text(String(info.lastMessage||'Press Pair with Raspberry Pi to begin.').slice(0,64),60,269,23,'#e8f3ff');
   cv.text('Choose PAIR -> scan QR -> log in to your private Pi -> approve.',60,312,21,'#8dbbed');
   if(info.lastDiagnostic)cv.text('Last diagnostic: '+String(info.lastDiagnostic.preset||'').slice(0,28),60,359,22,'#bcd6f4');
   if(p.pairUrl){try{drawQR(cv,p.pairUrl,1195,111,284);}catch(e){cv.text('QR error: '+e.message.slice(0,35),1160,322,18,'#ffc887');}}
  } else cv.text('Install the BMW AI Agent tool from this repository.',60,250,25,'#e8f3ff');
  if(error)cv.text(error.slice(0,100),60,427,19,'#ffc887');
  cv.text('Pairing code valid 2 min. No live vehicle controls or writing enabled.',60,469,19,'#89b5e4');
  return ctx.ui.image('MAIN_GFX',cv);
 });reload();
}});
