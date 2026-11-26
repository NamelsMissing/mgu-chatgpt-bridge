'use strict';

const {execFileSync}=require('node:child_process');
const seed=require('./service-reference-seed.json');
const HISTORY='servicehistory.serviceText';
const WORK=new Set(['oil','microfilter','check','airFilter','fuelFilter','brakeFluid','coolant','inspection']);
const python=String.raw`
import json, sqlite3, sys, os
from datetime import datetime, timezone
db=sqlite3.connect(sys.argv[1])
os.chmod(sys.argv[1],0o600)
db.executescript("""
CREATE TABLE IF NOT EXISTS definitions (id TEXT PRIMARY KEY, record TEXT NOT NULL, builtin INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS observations (
 namespace TEXT NOT NULL, code INTEGER NOT NULL, vehicle TEXT NOT NULL, first_seen TEXT NOT NULL,
 last_seen TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(namespace,code,vehicle));
CREATE TABLE IF NOT EXISTS observation_reads (
 namespace TEXT NOT NULL, code INTEGER NOT NULL, vehicle TEXT NOT NULL, read_id TEXT NOT NULL,
 PRIMARY KEY(namespace,code,vehicle,read_id));
""")
op=sys.argv[2]
data=json.load(sys.stdin)
with db:
 if op in ('seed','import') and (op!='seed' or db.execute("SELECT value FROM meta WHERE key='seed'").fetchone()!=(data['version'],)):
  if op=='seed':
   db.execute("DELETE FROM definitions WHERE builtin=1")
  for r in data['rows']:
   key=json.dumps([r[k] for k in ('namespace','code','vehicle','variant','interface','source','version','original','table')])
   record=json.dumps(r,sort_keys=True,ensure_ascii=False)
   old=db.execute('SELECT record FROM definitions WHERE id=?',(key,)).fetchone()
   if old and old[0]!=record:
    raise ValueError('conflicting existing reference')
   db.execute('INSERT OR IGNORE INTO definitions VALUES(?,?,?)',(key,record,int(op=='seed')))
  stamp=datetime.now(timezone.utc).isoformat()
  db.execute("INSERT OR REPLACE INTO meta VALUES('updatedAt',?)",(stamp,))
  if op=='seed':
   db.execute("INSERT OR REPLACE INTO meta VALUES('seed',?)",(data['version'],))
 if op=='observe':
  for r in data:
   if not db.execute('INSERT OR IGNORE INTO observation_reads VALUES(?,?,?,?)',(*r[:3], r[4])).rowcount: continue
   db.execute("""INSERT INTO observations VALUES(?,?,?,?,?,1)
     ON CONFLICT(namespace,code,vehicle) DO UPDATE SET first_seen=min(first_seen,excluded.first_seen),
     last_seen=max(last_seen,excluded.last_seen),count=count+1""",(*r[:3],r[3],r[3]))
  # Bound the receipt deduplication journal independently of aggregate counts.
  db.execute("DELETE FROM observation_reads WHERE rowid < (SELECT ifnull(max(rowid),0)-20000 FROM observation_reads)")
print(json.dumps(dict(rows=[json.loads(r[0]) for r in db.execute('SELECT record FROM definitions')],
 observations=db.execute('SELECT * FROM observations ORDER BY namespace,code').fetchall(),
 meta=dict(db.execute('SELECT * FROM meta'))),ensure_ascii=False))
`;

function code(value){
 if(typeof value==='string'&&/^(?:\d{1,5}|0x[0-9a-f]{1,4})$/i.test(value))value=Number(value);
 return Number.isInteger(value)&&value>=0&&value<=65535?value:null;
}
function historyCode(row){
 // The numeric serviceText might have been pre-labelled by an old app using IDScopeCBS.
 return code(row.code??row.scope);
}
function rowDefinition(row,imported){
 if(!row||typeof row!=='object')throw Error('Ungültige Referenzzeile.');
 const fields=['namespace','original','de','en','description','category','work','interface','source','vehicle','variant','compatibility','version','verification','table'];
 const out={code:code(row.code)};
 for(const field of fields){
  const value=row[field]??'';
  if(typeof value!=='string'||value.length>(field==='description'?500:180)||/[\x00-\x1f]/.test(value))throw Error('Ungültiges Referenzfeld '+field);
  out[field]=value.trim();
 }
 if(out.code===null||!(/^[A-Za-z0-9_.-]{2,180}$/.test(out.namespace))||
  !out.original||!out.interface||!out.source||!out.version||
  !['verified','reserved','unverified'].includes(out.verification)||
  (out.work&&!WORK.has(out.work))||(out.vehicle&&!/^[a-f0-9]{64}$/.test(out.vehicle))||
  (out.namespace===HISTORY&&out.code>255)||
  (imported&&out.verification==='verified'&&(!out.de||!out.description)))throw Error('Referenz benötigt Code, Herkunft, Version und einen gültigen Nachweisstatus.');
 out.hex='0x'+out.code.toString(16).toUpperCase().padStart(2,'0');
 return out;
}
function catalog(file){
 let data={rows:[],observations:[],meta:{}},index=new Map(),error=null,previousRead='';
 function command(op,input){
  try{
   const next=JSON.parse(execFileSync('python3',['-I','-c',python,file,op],{
    input:JSON.stringify(input),encoding:'utf8',timeout:5000,maxBuffer:8*1024*1024,stdio:['pipe','pipe','pipe']
   }));
   data=next;index=new Map();
   for(const row of data.rows){
    const key=row.namespace+':'+row.code;
    if(!index.has(key))index.set(key,[]);
    index.get(key).push(row);
   }
   error=null;
  }catch(e){error='Referenzdatenbank oder Referenzkonflikt';throw Error(error);}
 }
 function start(){
  try{command('seed',{...seed,rows:seed.rows.map(row=>rowDefinition(row,false))});}catch(e){}
 }
 function resolve(namespace,id,vehicle='',variant=''){
  const candidates=(index.get(namespace+':'+id)||[]).filter(row=>
   row.verification!=='unverified'&&(!row.vehicle||row.vehicle===vehicle)&&(!row.variant||row.variant===variant));
  const score=row=>Number(Boolean(row.vehicle))*2+Number(Boolean(row.variant));
  const best=candidates.filter(row=>score(row)===Math.max(...candidates.map(score)));
  const meanings=new Set(best.map(r=>JSON.stringify([r.de||r.original,r.work,r.verification])));
  if(meanings.size>1)return {status:'ambiguous'};
  const row=best[0];
  return row?{status:row.verification,row}:{status:'unknown'};
 }
 function observations(){
  return data.observations.map(([namespace,code,vehicle,firstSeen,lastSeen,count])=>({
   namespace,code,vehicle,firstSeen,lastSeen,count,interface:'ServiceHistory.readServiceHistory',
   status:resolve(namespace,code,vehicle).status
  }));
 }
 function view(){
  const observed=observations(),ambiguous=new Set();
  for(const row of data.rows){
   if(resolve(row.namespace,row.code,row.vehicle,row.variant).status==='ambiguous')
    ambiguous.add([row.namespace,row.code,row.vehicle,row.variant].join(':'));
  }
  const verified=new Set(data.rows.filter(r=>r.verification==='verified'&&
   resolve(r.namespace,r.code,r.vehicle,r.variant).status==='verified')
   .map(r=>[r.namespace,r.code,r.vehicle,r.variant].join(':')));
  return {version:data.meta.seed||null,updatedAt:data.meta.updatedAt||null,error,total:data.rows.length,
   confirmed:verified.size,unknown:observed.filter(r=>r.status==='unknown').length,
   ambiguous:ambiguous.size,ambiguousKeys:[...ambiguous],rows:data.rows,observations:observed};
 }
 function observe(history,vehicle,reference){
  if(!history||!data.meta.seed)return;
  const at=history.readAt&&/^\d{4}-\d\d-\d\dT/.test(history.readAt)&&Number.isFinite(Date.parse(history.readAt))?
   new Date(history.readAt).toISOString():null;
  const identities=new Map();
  for(const set of history.sets||[]){
   for(const row of set.services||[]){
    const id=historyCode(row);
    if(id===null||id>255)continue;
    const ref=at||reference(set);
    identities.set(id+':'+ref,[HISTORY,id,vehicle,at||new Date().toISOString(),ref]);
   }
  }
  const readId=JSON.stringify([vehicle,[...identities.keys()]]);
  if(readId===previousRead||!identities.size)return;
  try{command('observe',[...identities.values()]);previousRead=readId;}catch(e){}
 }
 function add(payload){
  if(payload?.schema!==1||!Array.isArray(payload.rows)||!payload.rows.length||payload.rows.length>2000)
   throw Error('Referenzimport benötigt schema 1 und 1–2000 Zeilen.');
  const rows=payload.rows.map(row=>rowDefinition(row,true));
  command('import',{rows});
  return view();
 }
 return {start,resolve,view,observe,add};
}
module.exports={catalog,code,historyCode,HISTORY};
