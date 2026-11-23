'use strict';
// Shared by the signed Pi application and the private MotorScope CLI importer.
function convert(exported, identities) {
  const catalogs=exported?.format==='motorscope-catalog-bundle'&&exported.version===1
    ? Array.isArray(exported.entries)?exported.entries.map(entry=>entry?.catalog):null
    : [exported];
  if(!Array.isArray(catalogs)||!catalogs.length)throw Error('MotorScope-Katalog fehlt');
  if(identities?.schema!==1||!identities.ecu||typeof identities.ecu!=='object')throw Error('Geprüfte ECU-Zuordnung fehlt');
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
    if(catalog.faultTexts===null||Array.isArray(catalog.faultTexts)||typeof catalog.faultTexts!=='object')throw Error('Ungültige Fehlertexttabelle für '+identity.sgbd);
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

function serialize(result){
  const bytes=JSON.stringify(result);
  if(Buffer.byteLength(bytes)>4*1024*1024)throw Error('Ausgabe überschreitet das Pi-Kataloglimit');
  return bytes;
}

module.exports={convert,serialize};
