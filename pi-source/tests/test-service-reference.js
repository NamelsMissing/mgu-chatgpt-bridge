'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {catalog,code,HISTORY}=require('../service-reference');
const seed=require('../service-reference-seed.json');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'bmw-service-reference-'));
try{
 const file=path.join(tmp,'refs.sqlite'),db=catalog(file);
 db.start();
 assert.equal(db.view().version,'1.0.0');
 assert.equal(seed.rows.filter(r=>r.namespace.endsWith('.IDScopeCBS')).length,24);
 assert.equal(seed.rows.filter(r=>r.namespace.endsWith('.ServiceStatusEnum')).length,3);
 assert.equal(seed.rows.filter(r=>r.namespace==='uds.kombi.cbs').length,85);
 assert.equal(code('11'),11);assert.equal(code('0x11'),17);
 const cbs='someip.de.bmw.infotainmenttypes.InfotainmentTypes.IDScopeCBS';
 assert.equal(db.resolve(cbs,17).row.de,'Fahrzeug-Check');
 assert.equal(db.resolve(cbs,65535).status,'reserved');
 assert.equal(db.resolve(HISTORY,17).status,'unknown');
 assert.equal(db.resolve('uds.kombi.cbs',17,'','KOMBSP21').status,'verified');
 assert.equal(db.resolve('uds.kombi.cbs',17).status,'unknown');
 const vehicle='1'.repeat(64);
 const history={readAt:'2026-11-26T12:00:00Z',sets:[{services:[{code:11,scope:'OELSERVICE'},{code:12},{code:11}]}]};
 db.observe(history,vehicle,()=> 'set');
 db.observe(history,vehicle,()=> 'set');
 const restarted=catalog(file);restarted.start();restarted.observe(history,vehicle,()=> 'set');
 assert.equal(restarted.view().unknown,2);
 assert.equal(restarted.view().observations.find(r=>r.code===11).count,1);
 restarted.observe({...history,readAt:'2026-11-27T12:00:00Z'},vehicle,()=> 'set');
 assert.equal(restarted.view().observations.find(r=>r.code===11).count,2);
 const row={namespace:HISTORY,code:'0x0B',vehicle,variant:'',original:'TEST',
  de:'Synthetischer Filter',work:'airFilter',interface:'ServiceHistory',source:'Synthetische Testreferenz',
  description:'Nur zur Prüfung des importierten Fahrzeugkontexts',version:'1',verification:'verified'};
 restarted.add({schema:1,rows:[row]});
 assert.equal(restarted.resolve(HISTORY,11,vehicle).row.work,'airFilter');
 assert.equal(restarted.resolve(HISTORY,11,'2'.repeat(64)).status,'unknown');
 assert.throws(()=>restarted.add({schema:1,rows:[{...row,verification:'unverified'}]}),/Referenzkonflikt/);
 restarted.add({schema:1,rows:[{...row,source:'Zweite synthetische Referenz',de:'Abweichende Testbezeichnung',work:'fuelFilter'}]});
 assert.equal(restarted.resolve(HISTORY,11,vehicle).status,'ambiguous');
 assert.equal(restarted.view().observations.find(r=>r.code===11).status,'ambiguous');
 assert.equal(fs.statSync(file).mode&0o777,0o600);
 const baseline=catalog(path.join(tmp,'baseline.sqlite'));baseline.start();
 const view=baseline.view();console.log('Service reference tests passed; baseline',view.total,view.confirmed,view.unknown,view.ambiguous);
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
