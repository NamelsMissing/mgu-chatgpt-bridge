'use strict';
// This file and shared/executor code intentionally support Node 8.7 on the MGU.
var fs=require('fs'),path=require('path'),http=require('http'),https=require('https'),dns=require('dns'),url=require('url'),cp=require('child_process');
var p=require('../shared/protocol'),executor=require('./executor');
function ensureDir(d){if(fs.existsSync(d))return;ensureDir(path.dirname(d));try{fs.mkdirSync(d,0o700);}catch(e){if(e.code!=='EEXIST')throw e;}}
function atomic(file,data){fs.writeFileSync(file+'.tmp',JSON.stringify(data),{mode:0o600});fs.renameSync(file+'.tmp',file);}
function transport(base,endpoint,key,body,leaseFile){
    return new Promise(function(resolve,reject){
        var u=new url.URL(base),local=['127.0.0.1','localhost'].indexOf(u.hostname)>=0;
        if(u.protocol!=='https:'&&!(u.protocol==='http:'&&local))return reject(Error('HTTPS required'));
        if(u.username||u.password||u.pathname!=='/'||u.search||u.hash)return reject(Error('Server URL must be a plain origin'));
        var wire=JSON.stringify(body||{}),options={protocol:u.protocol,hostname:u.hostname,port:u.port||undefined,path:endpoint,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(wire),authorization:'Bearer '+key},agent:false};
        // Resolve with the Store lease DNS without changing global resolver settings.
        if(leaseFile&&fs.existsSync(leaseFile)&&!local){
            try{var lease=JSON.parse(fs.readFileSync(leaseFile,'utf8'));if(lease.dns&&lease.dns.length){var resolver=new dns.Resolver();resolver.setServers(lease.dns);options.lookup=function(host,opts,cb){resolver.resolve4(host,function(e,a){cb(e,a&&a[0],4);});};}}
            catch(e){return reject(Error('Invalid Store uplink lease: '+e.message));}
        }
        var req=(u.protocol==='https:'?https:http).request(options,function(res){var chunks=[],n=0;res.on('data',function(b){n+=b.length;if(n>524288)req.destroy(Error('Response exceeds limit'));else chunks.push(b);});res.on('error',reject);res.on('end',function(){try{var data=JSON.parse(Buffer.concat(chunks));if(res.statusCode!==200)throw Error('HTTP '+res.statusCode+': '+(data.error||'Rejected'));resolve(data);}catch(e){reject(e);}});});
        req.setTimeout(15000,function(){req.destroy(Error('Network timeout'));});req.on('error',reject);req.end(wire);
    });
}
function createAgent(configFile,options){
    options=options||{};var config=JSON.parse(fs.readFileSync(configFile,'utf8'));
    config.dataDir=options.dataDir||config.dataDir||'/var/opt/mgu-chatgpt-bridge/data';config.configFile=configFile;ensureDir(config.dataDir);
    var stateFile=path.join(config.dataDir,'execution.json'),state;
    try{state=JSON.parse(fs.readFileSync(stateFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;state={seen:{},outbox:[]};}
    var active={child:null,cancelled:false},stopping=false,busy=false,timer=null,backoff=3000,lastError='',lastContact=null;
    function persist(){atomic(stateFile,state);}
    function reload(){var c=JSON.parse(fs.readFileSync(configFile,'utf8'));if(c.dataDir&&c.dataDir!==config.dataDir)throw Error('dataDir cannot change while running');config=Object.assign({},c,{dataDir:config.dataDir,configFile:configFile});}
    function status(){return {version:'0.1.0',updatedAt:Date.now(),enabled:config.enabled===true,paired:!!config.deviceKey,server:config.server||'',deviceId:config.deviceId||'',allowShell:config.allowShell===true,busy:busy,lastContact:lastContact,lastError:lastError,outbox:state.outbox.length};}
    function appIdentity(){
        var root='/var/opt/public/oap',dirs=[];
        if(config.appControlDir){dirs=[path.dirname(config.appControlDir)];}
        try{dirs=dirs.concat(fs.readdirSync(root).filter(function(s){return /^oap_\d+$/.test(s);}).map(function(s){return path.join(root,s);}));}catch(_){}
        for(var d of dirs)try{
            var pkg=JSON.parse(fs.readFileSync(path.join(d,'source/package.json'),'utf8'));
            if(pkg.name!=='mgu_chatgpt_bridge'||pkg.mguInternet!==true)continue;
            var data=path.join(d,'data');if(fs.realpathSync(data)!==data)continue;
            var st=fs.statSync(data);if(st.uid<=0||!st.isDirectory())continue;
            config.appControlDir=data;return {uid:st.uid,gid:st.gid};
        }catch(_){}
        return null;
    }
    async function send(endpoint,body){
        if(options.directTransport)return transport(config.server,endpoint,config.deviceKey,body,config.leaseFile);
        var identity=appIdentity();if(!identity)throw Error('Install MGU Analysis Bridge app first: its Internet-enabled UID is required');
        var lease=null;try{lease=JSON.parse(fs.readFileSync(config.leaseFile,'utf8'));}catch(_){}
        return new Promise(function(resolve,reject){
            var child=cp.spawn(process.execPath,[path.join(__dirname,'network-worker.js')],{uid:identity.uid,gid:identity.gid,stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin'}}),raw='',err='';
            var timer=setTimeout(function(){child.kill('SIGKILL');reject(Error('Network worker timeout'));},20000);
            child.stdout.on('data',function(b){raw+=b;if(raw.length>600000)child.kill('SIGKILL');});child.stderr.on('data',function(b){if(err.length<2000)err+=b;});
            child.on('error',function(e){clearTimeout(timer);reject(e);});child.on('close',function(code){clearTimeout(timer);try{if(code!==0)throw Error(err||'Network worker failed');var result=JSON.parse(raw);if(result.error)throw Error(result.error);resolve(result.value);}catch(e){reject(e);}});
            child.stdin.on('error',function(){});child.stdin.end(JSON.stringify({server:config.server,endpoint:endpoint,key:config.deviceKey,body:body,lease:lease}));
        });
    }
    async function flush(){while(state.outbox.length){await send('/device/result',state.outbox[0]);state.outbox.shift();persist();}}
    async function tick(){
        if(stopping||busy)return;busy=true;
        try{
            reload();if(config.enabled!==true||!config.deviceKey||!config.server)return;
            await flush();const envelope=await send('/device/poll',{});lastContact=Date.now();lastError='';backoff=3000;
            var j=envelope.job;if(!j)return;
            reload();if(stopping||config.enabled!==true)return;
            if(!p.equal(p.sign(j,config.deviceKey),envelope.signature)||j.deviceId!==config.deviceId||!p.equal(j.hash,p.hash(j.operation))||!Number.isSafeInteger(j.expiresAt)||j.expiresAt<=Date.now()||j.expiresAt>Date.now()+300000||!/^[a-f0-9]{24}$/.test(j.id))throw Error('Invalid, changed or expired job grant');
            p.validate(j.operation);
            if(state.seen[j.id])throw Error('Replayed job blocked');
            // Persist before executing: after a crash, never repeat an uncertain command.
            Object.keys(state.seen).forEach(function(id){if(state.seen[id].at<Date.now()-86400000)delete state.seen[id];});
            state.seen[j.id]={hash:j.hash,at:Date.now()};persist();
            active.cancelled=false;var result;
            try{result={ok:true,data:await executor.execute(j.operation,config,active)};}catch(e){result={ok:false,error:e.message};}
            state.outbox.push({id:j.id,hash:j.hash,result:result});persist();await flush();
        }catch(e){lastError=e.message;backoff=Math.min(backoff*2,60000);}
        finally{busy=false;}
    }
    function schedule(){if(stopping)return;timer=setTimeout(async function(){await tick();schedule();},backoff);}
    function cancel(){active.cancelled=true;if(active.child)try{process.kill(-active.child.pid,'SIGKILL');}catch(_){active.child.kill('SIGKILL');}}
    function pause(){reload();config.enabled=false;atomic(configFile,config);cancel();return status();}
    function resume(){reload();config.enabled=true;atomic(configFile,config);return status();}
    // File IPC uses OAP-owned request files, so no inbound TCP/firewall opening is needed.
    function processControl(){
        appIdentity();
        if(!config.appControlDir)return;
        try{
            var requestFile=path.join(config.appControlDir,'bridge-request.json');
            if(fs.existsSync(requestFile)){
                var st=fs.lstatSync(requestFile);if(!st.isFile()||st.isSymbolicLink()||st.size>1024)throw Error('Invalid local control file');
                var requestFd=fs.openSync(requestFile,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK),r;
                try{var requestStat=fs.fstatSync(requestFd);if(!requestStat.isFile()||requestStat.size>1024)throw Error('Invalid local request');r=JSON.parse(fs.readFileSync(requestFd,'utf8'));}finally{fs.closeSync(requestFd);}fs.unlinkSync(requestFile);
                if(r.action==='pause')pause();else if(r.action==='resume')resume();
            }
            var target=path.join(config.appControlDir,'bridge-status.json'),temp=target+'.'+require('crypto').randomBytes(12).toString('hex');
            // appControlDir must be configured by the root installer to an existing OAP data directory.
            var fd=fs.openSync(temp,'wx',0o644);
            try{fs.writeSync(fd,JSON.stringify(status()));fs.fchmodSync(fd,0o644);}finally{fs.closeSync(fd);}
            fs.renameSync(temp,target);
        }catch(e){lastError='Local control: '+e.message;}
    }
    var controlTimer;
    async function pair(base,code){config.server=base;var result=await send('/device/pair',{code:code});config.deviceId=result.deviceId;config.deviceKey=result.deviceKey;config.enabled=true;atomic(configFile,config);return status();}
    return {status:status,tick:tick,pause:pause,resume:resume,pair:pair,start:function(){controlTimer=setInterval(processControl,1000);tick().then(schedule);},stop:function(){stopping=true;clearTimeout(timer);clearInterval(controlTimer);cancel();},config:config};
}
async function main(){
    var file=process.env.BRIDGE_CONFIG||'/var/opt/mgu-chatgpt-bridge/config.json';
    if(process.argv[2]==='pair'){
        var base=process.argv[3],code=process.argv[4];if(!base||!code)throw Error('Usage: node agent.js pair https://bridge.example CODE');
        await createAgent(file).pair(base,code);console.log('Paired. Restart mgu-chatgpt-bridge.service.');return;
    }
    var agent=createAgent(file);agent.start();
    ['SIGTERM','SIGINT'].forEach(function(s){process.on(s,function(){agent.stop();setTimeout(function(){process.exit(0);},100);});});
}
if(require.main===module)main().catch(function(e){console.error('[mgu-bridge] '+e.message);process.exit(1);});
module.exports={createAgent:createAgent,transport:transport};
