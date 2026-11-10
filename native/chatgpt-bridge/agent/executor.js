'use strict';
var fs=require('fs'),path=require('path'),cp=require('child_process'),p=require('../shared/protocol');
// Two catalog commands must fit the broker's 512 KiB JSON cap even for control characters.
var LIMIT=32768;
function run(file,args,active) {
    return new Promise(function(resolve) {
        var out=[],err=[],size=0,limited=false,finished=false,timedOut=false;
        var child=cp.spawn(file,args,{stdio:['ignore','pipe','pipe'],detached:true,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C'}});
        active.child=child;
        function stop(){try{process.kill(-child.pid,'SIGKILL');}catch(_){try{child.kill('SIGKILL');}catch(__){}}}
        function collect(target,b){var left=LIMIT-size; if(left>0){target.push(b.slice(0,left));size+=Math.min(left,b.length);} if(b.length>left){limited=true;stop();}}
        var timer=setTimeout(function(){timedOut=true;stop();},10000);
        child.stdout.on('data',function(b){collect(out,b);}); child.stderr.on('data',function(b){collect(err,b);});
        function done(code,signal,error){if(finished)return;finished=true;clearTimeout(timer);stop();active.child=null;resolve({executable:file,args:args,stdout:Buffer.concat(out).toString('utf8'),stderr:Buffer.concat(err).toString('utf8'),exitCode:code,signal:signal||null,error:error||null,truncated:limited,timedOut:timedOut});}
        child.on('error',function(e){done(null,null,e.code||e.message);});child.on('close',function(c,s){done(c,s);});
    });
}
function beneath(file,root){return file===root||file.indexOf(root.replace(/\/$/,'')+'/')===0;}
function readFile(op,config){
    var real=fs.realpathSync(op.path);
    var denied=/(^|\/)(\.ssh|\.gnupg|shadow|gshadow|passwd|.*\.(key|pem|p12|pfx)|.*credentials.*|.*secrets.*)(\/|$)/i;
    if(denied.test(op.path)||denied.test(real)||beneath(real,config.dataDir)||beneath(real,'/var/opt/mgu-chatgpt-bridge')||(config.configFile&&real===fs.realpathSync(config.configFile)))throw Error('Sensitive path blocked');
    if(!(config.allowedReadRoots||[]).some(function(r){try{return beneath(real,fs.realpathSync(r));}catch(_){return false;}}))throw Error('Path outside local allowedReadRoots');
    var fd=fs.openSync(real,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    try{
        var st=fs.fstatSync(fd);if(!st.isFile())throw Error('Only regular files may be read');
        var buf=Buffer.alloc(op.length),n=fs.readSync(fd,buf,0,op.length,op.offset);buf=buf.slice(0,n);
        return {path:op.path,resolvedPath:real,offset:op.offset,bytes:n,totalBytes:st.size,eof:op.offset+n>=st.size,encoding:'base64',data:buf.toString('base64'),sha256:require('crypto').createHash('sha256').update(buf).digest('hex')};
    }finally{fs.closeSync(fd);}
}
async function execute(op,config,active){
    p.validate(op);
    if(op.type==='file')return readFile(op,config);
    if(op.type==='shell'){
        if(config.allowShell!==true)throw Error('Shell is disabled locally. Enable explicitly in config.json.');
        return run('/bin/sh',['-c',op.command],active);
    }
    var results=[];
    for(var c of p.CATALOG[op.name].commands){if(active.cancelled)throw Error('Execution stopped locally');results.push(await run(c[0],c[1],active));}
    return {diagnostic:op.name,commands:results};
}
module.exports={execute:execute,readFile:readFile};
