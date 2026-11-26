'use strict';

// Read-only capability probe. No generated ACL or configuration is installed;
// only the outcome for these fixed fields leaves the MGU.
var fs=require('fs'),path=require('path');
var CATALOG='/etc/oap/someip/someip-interfaces.json';
var FIRMWARE='/usr/lib/oap-mainapp/src/AppManagement/AppManagement.js';
var SOURCES=[
 ['Kilometerstand','de.bmw.infrastructure.SecureMileage','mileage'],
 ['Kilometerstand','de.bmw.infrastructure.MileageSupreme','mileageSupreme'],
 ['Kilometerstand','de.bmw.infrastructure.VehicleInformation','Range'],
 ['Check-Control','de.bmw.infotainment.checkcontrol.CheckControlMaster','basicList'],
 ['Check-Control','de.bmw.infotainment.KombiInterface_2','ccList'],
 ['Check-Control','de.bmw.infotainment.KombiInterface_2','ccListRiskClass'],
 ['Check-Control','de.bmw.infotainment.KombiInterface_2','newCCMessage'],
 ['CBS','de.bmw.infotainment.KombiInterface_2','cbsDataServiceList'],
 ['Reifen','de.bmw.infotainment.vehicle.TPMSInternalData','tpmsInternalLastValues'],
 ['Reifen','de.bmw.infotainment.vehicle.TPMS','statusTyrePressure'],
 ['Reifen','de.bmw.infotainment.vehicle.TPMS','statusTargetTyrePressure'],
];
['EngineOil','BrakeFront','BrakeRear','GearOil','ParticleFilter','SparkPlug'].forEach(function(name){
 SOURCES.push(['CBS','de.bmw.infotainment.ConditionBasedServicesLegacy','cBSMessage'+name]);
});
function loadGenerator(file){
 var text=fs.readFileSync(file,'utf8'),tail=/,\{\},\[\d+\]\)\s*;?\s*$/;
 var entry=/"someip-interfaces-generator\/IFConfigGenerator(?:\.js)?":(\d+)/.exec(text);
 var acl=/"someip-interfaces-generator\/AclGenerator(?:\.js)?":(\d+)/.exec(text);
 if(!entry||!acl||!tail.test(text))throw Error('generator_unavailable');
 // Same vendor bundle loading strategy as kit/tools/oapgen/gen.js. Firmware
 // path is fixed and trusted; discard the bundle's application entry point.
 var bundle=new Function('require','return '+text.trim().replace(tail,',{},[])'))(require);
 return {interface:bundle(entry[1]),acl:bundle(acl[1])};
}
function rejection(e){
 var text=String(e&&e.message||'');
 if(/cannot be read|getter|readable/i.test(text))return 'getter_unavailable';
 if(/cannot.*subscrib|event|notifier/i.test(text))return 'subscription_unavailable';
 if(/instanc/i.test(text))return 'instance_rejected';
 if(/interface/i.test(text))return 'interface_or_field_rejected';
 return 'generator_rejected';
}
function createReport(catalog,generator,manifest,installed){
 return SOURCES.map(function(source){
  var name=source[1],field=source[2],proxy=(manifest.proxies||{})[name]||{};
  var flags=(proxy.attributes||{})[field]||'',existing=installed[name]||{};
  var descriptor=(existing.fields||{})[field]||{};
  function test(flag,key){
   if(!catalog||!generator)return {supported:null,reason:'not_verified'};
   var request={proxies:{},services:{}},attributes={};
   attributes[field]=flag;
   request.proxies[name]={instances:'1',attributes:attributes};
   try{
    var generated=generator.interface.generate(catalog,request);
    generator.acl.generate(catalog,request);
    var iface=generated[name],member=iface&&(iface.fields||{})[field];
    return {supported:!!(member&&member[key]),reason:!iface?'interface_not_generated':!member?'field_not_generated':!member[key]?'descriptor_not_generated':null};
   }catch(e){return {supported:false,reason:rejection(e)};}
  }
  return {group:source[0],interface:name,field:field,instance:'1',
   manifestRead:flags.indexOf('r')!==-1,manifestSubscribe:flags.indexOf('s')!==-1,
   installedInterface:!!installed[name],installedGetter:!!descriptor.getter,installedSubscription:!!descriptor.event,
   catalogGetter:test('r','getter'),catalogSubscription:test('s','event')};
 });
}
function readJson(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function collect(root){
 var manifest={},installed={},catalog,generator,version=null,catalogState='readable',generatorState='ready';
 if(root){
  try{manifest=readJson(path.join(root,'source','manifest.json'));}catch(e){}
  try{version=readJson(path.join(root,'source','package.json')).version;}catch(e){}
  SOURCES.forEach(function(row){
   if(installed[row[1]])return;
   try{installed[row[1]]=readJson(path.join(root,'someipInterfaces',row[1].replace(/\./g,'_')+'.json'));}catch(e){}
  });
 }
 try{catalog=readJson(CATALOG);}catch(e){catalogState='unavailable';}
 try{generator=loadGenerator(FIRMWARE);}catch(e){generatorState='unavailable';}
 return {schema:1,at:new Date().toISOString(),vehicleDataVersion:/^\d+\.\d+\.\d+$/.test(version||'')?version:null,
  catalog:catalogState,generator:generatorState,rows:createReport(catalog,generator,manifest,installed)};
}
if(require.main===module){
 // Keep the child stdout reserved for the allowlisted JSON, even if the
 // firmware generator writes informational logs.
 console.log=console.info=function(){};
 process.stdout.write(JSON.stringify(collect(process.argv[2])));
}
module.exports={createReport:createReport};
