// Convert private MotorScope JSON exports. The input and output remain local.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

import importer from '../pi-source/dtc-import.js';
export const {convert}=importer;

function main([input,identities,output]){
  if(!input||!identities||!output)throw Error('Aufruf: node pi-tools/import-motorscope-dtc.mjs MOTOR_SCOPE_JSON ECU_JSON DATA_DIR/dtc-texts.json');
  const read=file=>{
    if(fs.statSync(file).size>64*1024*1024)throw Error('Eingabedatei zu groß');
    return JSON.parse(fs.readFileSync(file,'utf8'));
  };
  const result=convert(read(input),read(identities)),bytes=importer.serialize(result);
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
