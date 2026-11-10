'use strict';
const mgu=require('./kit/mgu'),fs=require('fs'),path=require('path'),qr=require('./qr');
function drawQR(cv,text,x,y,size){const q=qr(0,'M');q.addData(text);q.make();const n=q.getModuleCount(),step=Math.floor(size/(n+8)),total=step*(n+8),ox=x+(size-total)/2,oy=y+(size-total)/2;cv.roundRect(x-10,y-10,size+20,size+20,12,'#ffffff');for(let r=0;r<n;r++)for(let c=0;c<n;c++)if(q.isDark(r,c))cv.fillRect(ox+(c+4)*step,oy+(r+4)*step,step,step,'#071323');}
mgu.run({async start(ctx){
    let info=null,error='';
    function reload(){try{info=JSON.parse(fs.readFileSync(path.join(ctx.dataDir,'bridge-status.json'),'utf8'));error=(!info.updatedAt||Date.now()-info.updatedAt>10000)?'Background service status is stale':'';}catch(e){error='Background service not available yet';}}
    function request(action){try{fs.writeFileSync(path.join(ctx.dataDir,'bridge-request.json'),JSON.stringify({action:action}));error='';}catch(e){error=e.message;}}
    ctx.ui.onClick('BTN_RESUME',()=>request('resume'));ctx.ui.onClick('BTN_PAUSE',()=>request('pause'));ctx.ui.onClick('BTN_REFRESH',reload);
    ctx.loop('MAIN',1,async()=>{
        reload();const cv=ctx.canvas(1600,520);cv.clear('#090f1d');cv.roundRect(24,24,1552,472,24,'#131e31');
        cv.text('MGU ANALYSIS BRIDGE',62,93,44,'#e9f2ff',{font:'bold'});cv.text('ChatGPT diagnostics / v0.1.0',64,133,23,'#aebfd8');
        const online=info&&info.enabled&&info.paired&&!info.lastError;
        cv.text(error?'SERVICE OFFLINE':!info.paired?'PAIRING REQUIRED':!info.enabled?'PAUSED':info.lastError?'CONNECTION ERROR':'BRIDGE ENABLED',64,199,32,online?'#68dfa6':'#ffc682',{font:'bold'});
        if(info){
            const rows=['Server: '+(info.server||'not configured'),'Vehicle: '+(info.deviceId||'not paired'),'Last contact: '+(info.lastContact?new Date(info.lastContact).toISOString():'waiting'),'Shell: '+(info.allowShell?'locally enabled':'disabled')+'  |  Pending results: '+info.outbox];
            rows.forEach((s,i)=>cv.text(s.slice(0,75),64,249+i*36,22,'#d5e5fb'));
            if(info.lastError)cv.text(info.lastError.slice(0,90),64,410,21,'#ffc682');
            if(info.server)try{drawQR(cv,info.server+'/owner',1180,112,294);}catch(e){ctx.log.warn(e.message);}
        }else cv.text('Install the Bridge service, then pair your vehicle.',64,260,24,'#aebfd8');
        cv.text('Every job needs your exact approval in the private portal.',64,462,24,'#81c2ff');
        return ctx.ui.image('MAIN_GFX',cv);
    });reload();
}});
