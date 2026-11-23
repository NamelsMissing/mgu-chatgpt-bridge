// Convert private MotorScope JSON exports. The input and output remain local.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export function convert(exported, identities) {
  const catalogs=exported.format==='motorscope-catalog-bundle'&&exported.version===1
    ? exported.entries?.map(entry=>entry.catalog)
    : [exported];
  if(!Array.isArray(catalogs)||!catalogs.length)throw Error('MotorScope-Katalog fehlt');
  if(identities.schema!==1||!identities.ecu||typeof identities.ecu!=='object')throw Error('Geprüfte ECU-Zuordnung fehlt');
  const bySgbd=new Map(),ecu={},entries=[];
  for(const item of catalogs){
    if(!item||!item.faultTexts||!/^[A-Z0-9_]{1,40}$/i.test(item.sgbd||''))continue;
    const id=item.sgbd.toUpperCase(),previous=bySgbd.get(id);
    // A duplicated SGBD is ambiguous even when one file predates the other.
    bySgbd.set(id,previous===undefined?item:null);
  }
  for(const [address,identity] of Object.entries(identities.ecu)){
    if(!/^(0|[1-9][0-9]{0,2})$/.test(address)||Number(address)>255||identity?.verified!==true||
      !/^[A-Z0-9_]{1,40}$/.test(identity.sgbd||'')||!/^[A-Za-z0-9_/-]{1,40}$/.test(identity.family||'')||
      (identity.variant!=null&&!/^[A-Za-z0-9_./-]{1,80}$/.test(identity.variant)))throw Error('Ungültige geprüfte ECU-Zuordnung an Adresse '+address);
    const catalog=bySgbd.get(identity.sgbd);
    if(!catalog||catalog.provenance==='demo')throw Error('Kein eindeutiger Referenzkatalog für '+identity.sgbd);
    ecu[address]={family:identity.family,sgbd:identity.sgbd,variant:identity.variant||null};
    for(const [code,title] of Object.entries(catalog.faultTexts)){
      if(!/^[A-F0-9]{6}$/.test(code)||typeof title!=='string'||!title.trim())continue;
      const description=catalog.faultDescriptions?.[code];
      entries.push({...ecu[address],address:Number(address),code,title:title.trim().slice(0,200),
        ...(typeof description==='string'&&description.trim()?{description:description.trim().slice(0,700)}:{}),
        source:'MotorScope / '+identity.sgbd,verified:true});
    }
  }
  if(!entries.length||entries.length>30000)throw Error('Anzahl exportierbarer Fehlertexte ungültig');
  return {schema:1,ecu,entries};
}

function main([input,identities,output]){
  if(!input||!identities||!output)throw Error('Aufruf: node pi-tools/import-motorscope-dtc.mjs MOTOR_SCOPE_JSON ECU_JSON DATA_DIR/dtc-texts.json');
  const read=file=>{
    if(fs.statSync(file).size>64*1024*1024)throw Error('Eingabedatei zu groß');
    return JSON.parse(fs.readFileSync(file,'utf8'));
  };
  const result=convert(read(input),read(identities)),bytes=JSON.stringify(result);
  if(Buffer.byteLength(bytes)>4*1024*1024)throw Error('Ausgabe überschreitet das Pi-Kataloglimit');
  const temporary=path.resolve(output)+'.'+randomUUID()+'.tmp';
  try{
    fs.writeFileSync(temporary,bytes,{mode:0o600,flag:'wx'});
    fs.linkSync(temporary,output);
  }finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  console.log(result.entries.length+' Fehlertexte für '+Object.keys(result.ecu).length+' geprüfte ECU-Adressen importiert.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{main(process.argv.slice(2));}catch(e){console.error(e.message);process.exitCode=1;}
}
