'use strict';
const fs=require('fs'),path=require('path');
const dir=process.env.BRIDGE_DATA||path.join(__dirname,'data');
if(process.argv[2]!=='owner-key'){console.error('Usage: node broker/admin.js owner-key');process.exit(2);}
const state=JSON.parse(fs.readFileSync(path.join(dir,'state.json')));
process.stdout.write(state.owner+'\n');
