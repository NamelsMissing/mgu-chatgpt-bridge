'use strict';
var fs=require('fs'),path=require('path'),cp=require('child_process'),crypto=require('crypto');
var ROOTS=['/etc/cinemo','/etc/oap','/usr/lib','/var/log'];
function tokens(line){
 if(typeof line!=='string'||line.length>450||/[\x00-\x1f\x7f]/.test(line))throw Error('Invalid command');
 var a=[],v='',q='',active=false;
 for(var i=0;i<line.length;i++){var c=line[i];
  if(q){if(c===q)q='';else v+=c;active=true;continue;}
  if(c==='"'||c==="'"){q=c;active=true;continue;}
  if(/\s/.test(c)){if(active){a.push(v);v='';active=false;}continue;}
  if(/[;&|<>\x60$\\]/.test(c))throw Error('Shell operators not allowed');
  v+=c;active=true;
 }
 if(q)throw Error('Unclosed quote');if(active)a.push(v);
 if(!a.length||a.length>12)throw Error('Invalid command length');return a;
}
function allowed(p){
 if(typeof p!=='string'||p[0]!=='/'||p.length>300)throw Error('Absolute path required');
 var full=path.resolve(p),real=fs.realpathSync(full);
 if(!ROOTS.some(function(r){return real===r||real.indexOf(r+'/')===0;}))throw Error('Path outside read-only allowlist');
 var parts=full.split('/').filter(Boolean),cur='';
 parts.forEach(function(x){cur+='/'+x;if(fs.lstatSync(cur).isSymbolicLink())throw Error('Symlinks are not allowed');});return real;
}
function file(p,limit){
 var f=allowed(p),fd=fs.openSync(f,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{var st=fs.fstatSync(fd);if(!st.isFile()||st.size>limit)throw Error('File is not regular or exceeds limit');
  var b=Buffer.alloc(st.size),i=0;while(i<b.length){var n=fs.readSync(fd,b,i,b.length-i,i);if(!n)break;i+=n;}return b.slice(0,i);
 }finally{fs.closeSync(fd);}
}
function textFile(p){var b=file(p,256*1024);if(b.indexOf(0)>=0)throw Error('Binary file: use strings FILE TERM');return b.toString('utf8');}
function directory(p){var f=allowed(p);if(!fs.statSync(f).isDirectory())throw Error('Not a directory');return f;}
function cmd(b,args){try{return cp.execFileSync(b,args,{timeout:5000,encoding:'utf8',maxBuffer:50000}).slice(0,32000);}catch(e){return '[unavailable] '+String(e.message).slice(0,200);}}
function first(paths){for(var i=0;i<paths.length;i++)if(fs.existsSync(paths[i]))return paths[i];return paths[0];}
function run(line){
 var t=tokens(line),kind=t.shift(),out='',f,parts;
 switch(kind){
 case 'help':out='help, pwd, uname -a, uptime, ip -4 addr, ip -4 route, ps, systemctl --failed, ls [-la] DIR, cat FILE, head [-n N] FILE, tail [-n N] FILE, grep [-niE] TERM FILE, find DIR TERM, strings FILE TERM, stat PATH, sha256sum FILE';break;
 case 'pwd':if(t.length)throw Error('Usage: pwd');out='/';break;
 case 'uname':if(t.length>1||t[0]&&t[0]!=='-a')throw Error('Usage: uname -a');out=cmd('/bin/uname',['-a']);break;
 case 'uptime':if(t.length)throw Error('Usage: uptime');out=cmd(first(['/usr/bin/uptime','/bin/uptime']),[]);break;
 case 'ip':if(t.length!==2||t[0]!=='-4'||['addr','route'].includes(t[1])===false)throw Error('Usage: ip -4 addr/route');out=cmd(first(['/sbin/ip','/usr/sbin/ip','/bin/ip']),t);break;
 case 'ps':if(t.length)throw Error('Usage: ps');out=cmd(first(['/bin/ps','/usr/bin/ps']),[]);break;
 case 'systemctl':if(t.length!==1||t[0]!=='--failed')throw Error('Only systemctl --failed');out=cmd('/bin/systemctl',['--failed','--no-pager','--plain']);break;
 case 'ls':
  if(t[0]==='-la'||t[0]==='-l')t.shift();if(t.length!==1)throw Error('Usage: ls [-la] DIR');
  f=directory(t[0]);out=fs.readdirSync(f).slice(0,180).map(function(x){var s=fs.lstatSync(path.join(f,x));return (s.isDirectory()?'d':s.isSymbolicLink()?'l':'-')+' '+s.size+' '+x;}).join('\n');break;
 case 'cat':if(t.length!==1)throw Error('Usage: cat FILE');out=textFile(t[0]);break;
 case 'head':case 'tail':
  var n=30;if(t[0]==='-n'){if(!/^\d{1,3}$/.test(t[1]||''))throw Error('Invalid line count');n=Math.min(150,Number(t[1]));t.splice(0,2);}
  if(t.length!==1)throw Error('Usage: '+kind+' [-n N] FILE');parts=textFile(t[0]).split('\n');out=(kind==='head'?parts.slice(0,n):parts.slice(-n)).join('\n');break;
 case 'grep':
  if(['-niE','-inE','-ni','-i'].indexOf(t[0])>=0)t.shift();
  if(t.length!==2||!t[0]||t[0].length>100)throw Error('Usage: grep [-niE] TERM FILE');
  var terms=t[0].toLowerCase().split('|').filter(Boolean);if(terms.length>10)throw Error('Too many terms');
  out=textFile(t[1]).split('\n').map(function(x,i){return terms.some(function(y){return x.toLowerCase().indexOf(y)>=0;})?(i+1)+': '+x:null;}).filter(Boolean).slice(0,180).join('\n');break;
 case 'find':
  if(t.length!==2||!t[1]||t[1].length>80)throw Error('Usage: find DIR TERM');
  var needle=t[1].replace(/\*/g,'').toLowerCase();if(!needle)throw Error('Search term required');
  var queue=[[directory(t[0]),0]],found=[],count=0;
  while(queue.length&&count<1800&&found.length<180){var d=queue.shift(),names=fs.readdirSync(d[0]);for(var k=0;k<names.length&&count<1800;k++){count++;var x=names[k],full=path.join(d[0],x);if(x.toLowerCase().indexOf(needle)>=0)found.push(full);
   try{var info=fs.lstatSync(full);if(info.isDirectory()&&!info.isSymbolicLink()&&d[1]<3)queue.push([full,d[1]+1]);}catch(e){}
   if(found.length>=180)break;
  }}out=found.join('\n')+'\n[read-only search; max depth 4, 180 matches]';break;
 case 'strings':
  if(t.length!==2||!t[1]||t[1].length>80)throw Error('Usage: strings FILE TERM');
  var data=file(t[0],2*1024*1024).toString('latin1'),exp=/[\x20-\x7e]{5,}/g,matches=[],match;
  while((match=exp.exec(data))&&matches.length<140){if(match[0].toLowerCase().indexOf(t[1].toLowerCase())>=0)matches.push(match[0].slice(0,400));}
  out=matches.join('\n');break;
 case 'stat':
  if(t.length!==1)throw Error('Usage: stat PATH');f=allowed(t[0]);var st=fs.lstatSync(f);
  out=JSON.stringify({path:f,size:st.size,mode:(st.mode&0o777).toString(8),modified:st.mtime.toISOString(),type:st.isDirectory()?'directory':'file'},null,2);break;
 case 'sha256sum':if(t.length!==1)throw Error('Usage: sha256sum FILE');out=crypto.createHash('sha256').update(file(t[0],8*1024*1024)).digest('hex')+'  '+t[0];break;
 default:throw Error('Command not permitted. Type help for read-only commands.');
 }
 return {command:line,stdout:String(out).slice(0,32000),exitCode:0,readOnly:true,at:new Date().toISOString()};
}
module.exports={run:run,tokens:tokens};
