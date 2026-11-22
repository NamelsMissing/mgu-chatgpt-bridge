'use strict';
const {spawn}=require('node:child_process');

function configured(){
  return /^[a-z_][a-z0-9_-]*@[a-z0-9][a-z0-9.-]*$/i.test(process.env.MGU_SSH_TARGET||'');
}
function connect(remote,input,keepOpen){
  if(!configured())throw Object.assign(Error('SSH-Zugang auf dem Pi nicht eingerichtet'),{status:503});
  const config=process.env.MGU_SSH_CONFIG;
  const args=config?['-F',config]:[];
  const child=spawn('/usr/bin/ssh',[...args,'-T','-oBatchMode=yes','-oStrictHostKeyChecking=yes',
    '-oConnectTimeout=8','-oServerAliveInterval=5','-oServerAliveCountMax=2',
    process.env.MGU_SSH_TARGET,remote],{stdio:['pipe','pipe','pipe']});
  child.stdin.on('error',()=>{});
  if(keepOpen)child.stdin.write(input);
  else child.stdin.end(input);
  return child;
}
function execute(remote,input,signal,keepOpen=false){
  const child=connect(remote,input,keepOpen);
  return new Promise((resolve,reject)=>{
    const stdout=[],stderr=[];
    let bytes=0,limit=false,timedOut=false;
    let killTimer;
    const stop=()=>child.kill('SIGKILL');
    const cancel=()=>{
      if(!keepOpen)return stop();
      child.stdin.end();
      killTimer=setTimeout(stop,2500);
    };
    const timer=setTimeout(()=>{timedOut=true;stop();},52000);
    const cleanup=()=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',cancel);};
    if(signal?.aborted)cancel();
    else signal?.addEventListener('abort',cancel,{once:true});
    function collect(to,chunk){
      bytes+=chunk.length;
      if(bytes>4*1024*1024){if(!limit){limit=true;cancel();}}
      else to.push(chunk);
    }
    child.stdout.on('data',b=>collect(stdout,b));
    child.stderr.on('data',b=>collect(stderr,b));
    child.once('error',e=>{cleanup();reject(e);});
    child.once('close',(code)=>{
      cleanup();
      resolve({stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8'),
        exitCode:code,cancelled:signal?.aborted===true,timedOut:timedOut||code===124,outputLimit:limit});
    });
  });
}

// An open SSH stdin keeps the job alive. EOF requests cancellation on the MGU.
function remoteCommand(){
  const spawn=require('child_process').spawn;
  let input='',child=null,force=null,deadline=null,timedOut=false;
  function stop(){
    if(!child||force)return;
    function kill(signal){try{process.kill(-child.pid,signal);}catch(e){}}
    kill('SIGTERM');
    force=setTimeout(()=>kill('SIGKILL'),1000);
  }
  process.stdin.setEncoding('utf8');
  process.stdin.on('data',function(chunk){
    if(child)return;
    input+=chunk;
    if(input.length>100000){process.exit(125);return;}
    const end=input.indexOf('\n');
    if(end<0)return;
    const command=JSON.parse(input.slice(0,end));
    child=spawn('/bin/sh',['-c',command],{detached:true,stdio:['ignore','inherit','inherit']});
    deadline=setTimeout(function(){timedOut=true;stop();},35000);
    child.on('error',function(e){process.stderr.write(String(e)+'\n');process.exit(125);});
    child.on('close',function(code){
      clearTimeout(deadline);
      if(force){
        // Do not leave grandchildren alive if the shell exited before they did.
        try{process.kill(-child.pid,'SIGKILL');}catch(e){}
        clearTimeout(force);
      }
      process.exitCode=timedOut?124:code===null?130:code;
      process.stdin.destroy();
    });
  });
  process.stdin.on('end',stop);
  process.on('SIGHUP',stop);
  process.on('SIGTERM',stop);
}
function runCommand(command,signal){
  const source='('+remoteCommand.toString()+')()';
  const quoted="'"+source.replace(/'/g,"'\\''")+"'";
  return execute('/usr/bin/node -e '+quoted,JSON.stringify(command)+'\n',signal,true);
}

// Sent to the fixed Node entry point via stdin. The path remains a data value in the
// program and never becomes a remote shell argument. Files use the SSH account's rights.
function remoteFile(request){
  const fs=require('fs'),path=require('path');
  const constants=fs.constants;
  function send(data){process.stdout.write(JSON.stringify(data)+'\n');}
  try{
    const target=fs.realpathSync(request.path),stat=fs.statSync(target);
    if(request.download){
      if(!stat.isFile())throw new Error('Nur reguläre Dateien können heruntergeladen werden');
      const fd=fs.openSync(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const opened=fs.fstatSync(fd);
      if(!opened.isFile()){fs.closeSync(fd);throw new Error('Nur reguläre Dateien können heruntergeladen werden');}
      if(!opened.size){
        const probe=fs.readSync(fd,Buffer.alloc(1),0,1,null);
        fs.closeSync(fd);
        if(probe)throw new Error('Virtuelle Datei ohne feste Dateigröße kann nicht sicher übertragen werden');
        send({bytes:0});return;
      }
      send({bytes:opened.size});
      const stream=fs.createReadStream(target,{fd:fd,start:0,end:opened.size-1,autoClose:false});
      stream.on('error',()=>{fs.closeSync(fd);process.exitCode=1;});
      stream.on('end',()=>{
        try{
          const after=fs.fstatSync(fd);
          if(after.size!==opened.size||after.mtimeMs!==opened.mtimeMs)process.exitCode=1;
        }catch(e){process.exitCode=1;}
        finally{fs.closeSync(fd);}
      });
      stream.pipe(process.stdout);
      return;
    }
    if(stat.isFile()){
      send({path:request.path,file:true,entries:[{name:path.basename(request.path),kind:'file',bytes:stat.size,mtime:stat.mtime.toISOString()}]});
      return;
    }
    if(!stat.isDirectory())throw new Error('Pfad ist weder Datei noch Verzeichnis');
    const entries=[],pending=[{dir:target,relative:'',depth:0}];
    const limit=250,term=request.term||'',deadline=Date.now()+5000;
    let scanned=0,matched=0,truncated=false,skipped=0;
    while(pending.length){
      if(entries.length===limit||Date.now()>deadline||scanned>=10000){truncated=true;break;}
      const current=pending.shift();
      let names;
      try{names=fs.readdirSync(current.dir).sort();}catch(e){if(!current.depth)throw e;skipped++;continue;}
      for(const name of names){
        if(entries.length===limit||Date.now()>deadline||scanned>=10000){truncated=true;break;}
        scanned++;
        const full=path.join(current.dir,name),relative=path.join(current.relative,name);
        const matches=name.toLowerCase().indexOf(term)>=0;
        if(!matches&&!request.recursive)continue;
        let st;
        try{st=fs.lstatSync(full);}catch(e){skipped++;continue;}
        const kind=st.isSymbolicLink()?'symlink':st.isDirectory()?'directory':st.isFile()?'file':'special';
        if(request.recursive&&kind==='directory'&&current.depth<8)pending.push({dir:full,relative:relative,depth:current.depth+1});
        if(matches&&matched++>=request.offset)entries.push({name:relative,kind:kind,bytes:st.size,mtime:st.mtime.toISOString()});
      }
    }
    send({path:request.path,entries:entries,truncated:truncated,next:entries.length===limit&&truncated?request.offset+limit:null,skipped:skipped});
  }catch(e){send({error:e.code||e.message});}
}
const fileInput=request=>'('+remoteFile.toString()+')('+JSON.stringify(request)+');\n';
async function browse(request){
  const result=await execute('/usr/bin/node -',fileInput(request));
  if(result.exitCode!==0)throw Object.assign(Error('SSH-Dateibrowser fehlgeschlagen'),{status:502});
  return parseFileHeader(result.stdout);
}
function parseFileHeader(line){
  let data;
  try{data=JSON.parse(line);}catch(e){throw Object.assign(Error('Ungültige Antwort des SSH-Dateidienstes'),{status:502});}
  if(data.error){
    const detail={ENOENT:'Pfad nicht vorhanden',EACCES:'Zugriff verweigert',EPERM:'Zugriff verweigert',ENOTDIR:'Pfadbestandteil ist kein Verzeichnis',ELOOP:'Schleife in symbolischen Links'};
    throw Object.assign(Error(detail[data.error]||data.error),{status:data.error==='ENOENT'?404:/(EACCES|EPERM)/.test(data.error)?403:400});
  }
  return data;
}

async function transfer(target,res,onSize){
  const child=connect('/usr/bin/node -',fileInput({path:target,download:true}));
  child.stderr.resume();
  let exitCode,launchError;
  const closed=new Promise(resolve=>{
    child.once('error',error=>{launchError=error;});
    child.once('close',code=>{exitCode=code;resolve();});
  });
  const stop=()=>child.kill('SIGKILL');
  const timer=setTimeout(stop,10*60000);
  res.once('close',stop);
  try{
    let header=Buffer.alloc(0),remaining=null;
    for await(let chunk of child.stdout){
      if(remaining===null){
        chunk=Buffer.concat([header,chunk]);
        const end=chunk.indexOf(10);
        if(end<0){
          if(chunk.length>4096)throw Error('Ungültiger Download-Header');
          header=chunk;
          continue;
        }
        const meta=parseFileHeader(chunk.subarray(0,end).toString('utf8'));
        remaining=meta.bytes;
        if(!Number.isSafeInteger(remaining)||remaining<0)throw Error('Ungültige Dateigröße');
        onSize(remaining);
        chunk=chunk.subarray(end+1);
      }
      if(chunk.length>remaining)throw Error('Dateigröße hat sich während der Übertragung geändert');
      remaining-=chunk.length;
      // Reserve the final byte until SSH confirms success. Otherwise the browser could
      // accept the Content-Length before a late transport failure becomes visible.
      if(remaining===0&&chunk.length){
        await closed;
        if(exitCode!==0)throw Error('SSH-Download unterbrochen');
      }
      if(chunk.length&&!res.write(chunk)){
        await new Promise(resolve=>{
          function ready(){res.off('drain',ready);res.off('close',ready);resolve();}
          res.once('drain',ready);res.once('close',ready);
          if(res.destroyed)ready();
        });
      }
    }
    await closed;
    if(launchError||exitCode!==0||remaining!==0)throw Object.assign(Error('SSH-Download unterbrochen'),{status:502});
  }finally{
    clearTimeout(timer);
    res.off('close',stop);
    stop();
  }
}
async function download(target,res,headers){
  await transfer(target,res,size=>res.writeHead(200,{...headers,'content-length':size}));
  res.end();
}
async function readSmall(target,limit){
  const {Writable}=require('node:stream');
  const chunks=[];
  const sink=new Writable({write(chunk,encoding,cb){chunks.push(Buffer.from(chunk));cb();}});
  await transfer(target,sink,size=>{
    if(size>limit)throw Object.assign(Error('Datei zu groß für die Pi-Bibliothek. Verwende den Direktdownload.'),{status:413});
  });
  sink.end();
  return Buffer.concat(chunks);
}
module.exports={configured,execute,runCommand,browse,download,readSmall};
