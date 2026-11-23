import assert from 'node:assert/strict';
import {convert} from '../pi-tools/import-motorscope-dtc.mjs';

const catalogs={format:'motorscope-catalog-bundle',version:1,entries:[
  {address:null,catalog:{sgbd:'FIXTURE',provenance:'prg',faultTexts:{A1B2C3:'Testtitel'},faultDescriptions:{A1B2C3:'Testbeschreibung'}}},
  {address:null,catalog:{sgbd:'OTHER',provenance:'prg',faultTexts:{A1B2C3:'Falsche ECU'}}},
]};
const vehicle={schema:1,ecu:{18:{family:'FixtureECU',sgbd:'FIXTURE',variant:'FICTIONAL',verified:true}}};
const imported=convert(catalogs,vehicle);
assert.deepEqual(imported.entries,[{
 address:18,family:'FixtureECU',sgbd:'FIXTURE',variant:'FICTIONAL',code:'A1B2C3',title:'Testtitel',
 description:'Testbeschreibung',source:'MotorScope / FIXTURE',verified:true
}]);
assert.throws(()=>convert({...catalogs,entries:[...catalogs.entries,catalogs.entries[0]]},vehicle),/eindeutiger Referenzkatalog/);
assert.throws(()=>convert(catalogs,{schema:1,ecu:{18:{...vehicle.ecu[18],verified:false}}}),/Ungültige geprüfte ECU-Zuordnung/);
console.log('MotorScope import: verified identity, unknown and duplicate catalog isolation passed.');
