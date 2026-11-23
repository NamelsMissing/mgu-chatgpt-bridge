'use strict';
// Vehicle Data: read-only manifest, decoding of mileage, CBS and service history, snapshot file.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '..');
const spec = JSON.parse(fs.readFileSync(path.join(root, 'apps/vehicle_data/app.json'), 'utf8'));
const src = fs.readFileSync(path.join(root, 'apps/vehicle_data/main.js'), 'utf8');
const V = require('../apps/vehicle_data/vehicle_snapshot.js');
const Module = require('module');
const resolve0 = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (/^\.\/kit\//.test(request) && parent && /apps[\\/]vehicle_data/.test(parent.filename)) return require.resolve('../kit/runtime/' + request.slice(6));
    return resolve0.call(this, request, parent, ...rest);
};
const F = require('../apps/vehicle_data/vehicle_faults.js');
const { Diag } = require('../kit/runtime/diag');

// Read-only: no setter flags, no CBS reset, no UDS transport.
for (const [iface, fields] of Object.entries(spec.signals)) {
    for (const [k, v] of Object.entries(fields)) if (!k.startsWith('_')) assert.ok(!/w/.test(v), iface + '.' + k + ' must not be writable');
}
assert.ok(!('cBSReset' in spec.signals['de.bmw.infotainment.ConditionBasedServicesLegacy']));
assert.ok(!/signals\.set\(|cBSReset|sendTasuRequest/.test(src), 'nothing is written to the car');
// Diagnostics: only the two read services, enforced by ReadOnlyDiag.
const calls = src.match(/\.(functional|physical|send)\(\s*(0x[0-9A-Fa-f]+|[A-Za-z_.]+)/g) || [];
assert.deepStrictEqual(calls.map((c) => c.replace(/\s+/g, '')), ['.send(target', '.functional(0x19'], 'only the guarded send and the 0x19 read');
assert.ok(/if \(sid !== 0x19 && sid !== 0x22\) throw/.test(src) && /data\[0\] !== 0x02/.test(src));
assert.strictEqual(spec.mguAppStartType, 'autostart');
assert.ok(/AUTOSTART_APPS = \("vehicle_data",\)/.test(fs.readFileSync(path.join(root, 'tools/build_store_app.py'), 'utf8')));
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'mgu-repo.json'), 'utf8')).components.find((c) => c.id === 'vehicle_data').build.python, 'tools/build_store_app.py');
const repo = JSON.parse(fs.readFileSync(path.join(root, 'mgu-repo.json'), 'utf8'));
assert.strictEqual(repo.components.find((c) => c.id === 'vehicle_data').version, spec.version);
assert.deepStrictEqual(Object.keys(spec.signals['de.bmw.infotainment.ConditionBasedServicesLegacy']), V.CBS_FIELDS);

// Mileage
assert.deepStrictEqual(V.decodeSecureMileage({ currentMileage: 143350, aliveCounter: 3, manipulationState: 0 }).km, 143350);
assert.strictEqual(V.decodeSecureMileage({ currentMileage: 0xFFFFFFFF }).km, null, 'all bits set = no value');
assert.strictEqual(V.decodeSecureMileage({ currentMileage: 0 }).km, null);
assert.strictEqual(V.decodeMileageSupreme({ mileageSupreme: 143351, qualifierMileageSupreme: 'EVENT_DATA_AVAILABLE' }).km, 143351);
assert.strictEqual(V.decodeMileageSupreme({ mileageSupreme: 143351, qualifierMileageSupreme: 0 }).km, 143351, 'enum as wire number');
assert.strictEqual(V.decodeMileageSupreme({ mileageSupreme: 143351, qualifierMileageSupreme: 'EVENT_DATA_INVALID_OR_TIMEOUT' }).km, null);

assert.strictEqual(V.rangeMileage({mileageKilometre:143352}),143352);
for(const invalid of [undefined,null,{}, {mileageKilometre:0}, {mileageKilometre:0xFFFFFF}, {mileageKilometre:'143352'}])assert.strictEqual(V.rangeMileage(invalid),null);
const fullCbs=['OELSERVICE','BREMSFLUESSIGKEIT'].map(cBSIdentifier=>({cBSDataServiceWithSymbolID:{
    cBSDataService:{cBSIdentifier,yearCBSDisplay:2027,monthCBSDisplay:5,cBSServiceWay:12345},dayCBSDisplay:0
}}));
assert.deepStrictEqual(V.decodeCbsList(fullCbs).map(c=>[c.scope,c.dueMonth,c.remainingKm]),[
    ['OELSERVICE','2027-05',null],['BREMSFLUESSIGKEIT','2027-05',null]]);
assert.strictEqual(V.decodeCbsList([{}]),null);
assert.deepStrictEqual(V.decodeServiceHistory({statusOperation:0,dataSets:[]}),{status:'E_OK',sets:[]});
assert.strictEqual(V.decodeServiceHistory({statusOperation:0}).status,null);

// CBS: member names carry the field's suffix; enums may come as names or numbers.
const oil = V.decodeCbs('cBSMessageEngineOil', { iDScopeCBSMessageEngineOil: 'OELSERVICE', statusScopeCBSMessageEngineOil: 1,
    counterCBSMessageEngineOil: 0, remainingMileageCBSMessageEngineOil: 850, forecastWayCBSMessageEngineOil: 0,
    targetDateDayCBSMessageEngineOil: 1, targetDateMonthCBSMessageEngineOil: 4, targetDateYearCBSMessageEngineOil: 27,
    forecastTimeCBSMessageEngineOil: 0, availibilityCBSMessageEngineOil: 1 });
assert.strictEqual(oil.label, 'Motoröl'); assert.strictEqual(oil.remainingKm, 850); assert.strictEqual(oil.dueDate, '2027-04-01');
assert.strictEqual(oil.availability, 1, 'BMW spells it "availibility"'); assert.strictEqual(oil.unverified, true);
const fluid = V.decodeCbs('cBSMessageBrakeRear', { iDScopeCBSMessageBrakeRear: 3, remainingMileageCBSMessageBrakeRear: 65535,
    targetDateDayCBSMessageBrakeRear: 31, targetDateMonthCBSMessageBrakeRear: 2, targetDateYearCBSMessageBrakeRear: 27 });
assert.strictEqual(fluid.scope, 'BREMSFLUESSIGKEIT'); assert.strictEqual(fluid.remainingKm, null); assert.strictEqual(fluid.dueDate, null, '31 February is no date');
const spark = V.decodeCbs('cBSMessageSparkPlug', { iDScopeCBSMessageSparkPlug: 16, availabilityCBSMessageSparkPlug: 0 });
assert.strictEqual(spark.availability, 0, 'spark plug field spells it correctly');
assert.strictEqual(V.decodeCbs('cBSMessageGearOil', { iDScopeCBSMessageGearOil: 'SIGNAL_UNBEFUELLT' }), null);

// Service history
const h = V.decodeServiceHistory({ numberOfDataSets: 2, statusOperation: 'E_OK', dataSets: [
    { dateOfService: { dayOfService: 7, monthOfService: 11, yearOfService: 2024 }, correctionNumber: 0, mileage: 118900,
      dealerInfo: { whichDealer: 1, dealerNumber: '12345 ' }, serviceStatus: 1, numberOfServiceEntries: 1,
      serviceEntries: [{ serviceText: 3, serviceStatusPos: 'SERVICE_PERFORMED', remainingDistance: 0, remainingTime: 24 }] },
    { dateOfService: { dayOfService: 1, monthOfService: 4, yearOfService: 2026 }, mileage: 136200, dealerInfo: { dealerNumber: '' },
      serviceStatus: 'SERVICE_CARRIED_OUT_LATE', serviceEntries: [{ serviceText: 1, serviceStatusPos: 1 }, { serviceText: 4, serviceStatusPos: 1 }, { serviceText: 250 }] },
] });
assert.strictEqual(h.status, 'E_OK');
assert.deepStrictEqual(h.sets.map((s) => s.date), ['2026-04-01', '2024-11-07'], 'newest first');
assert.deepStrictEqual(h.sets[0].services.map((s) => s.label), ['Motoröl', 'Mikrofilter', 'Code 250']);
assert.strictEqual(h.sets[0].status, 'SERVICE_CARRIED_OUT_LATE'); assert.strictEqual(h.sets[1].dealer, '12345');
assert.strictEqual(V.decodeServiceHistory({ statusOperation: 2 }).status, 'E_FILE_IS_EMPTY');

// Snapshot file: atomic, only on change, at most once per second, SecureMileage preferred.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-'));
let t = 1700000000000;
const s = new V.VehicleSnapshot({ dir, version: '0.1.0', now: () => t });
s.mileageSupreme({ mileageSupreme: 143300, qualifierMileageSupreme: 0 });
assert.strictEqual(s.flush(), true);
let doc = JSON.parse(fs.readFileSync(path.join(dir, V.FILE), 'utf8'));
assert.strictEqual(doc.mileage.km, 143300); assert.strictEqual(doc.mileage.source, 'MileageSupreme'); assert.strictEqual(doc.schema, 1);
s.secureMileage({ currentMileage: 143350, manipulationState: 0 });
assert.strictEqual(s.flush(), false, 'at most once per second');
t += 1500; assert.strictEqual(s.flush(), true);
doc = JSON.parse(fs.readFileSync(path.join(dir, V.FILE), 'utf8'));
assert.strictEqual(doc.mileage.km, 143350); assert.strictEqual(doc.mileage.source, 'SecureMileage');
t += 1500; assert.strictEqual(s.flush(), false, 'unchanged: no write');
s.cbs('cBSMessageEngineOil', { iDScopeCBSMessageEngineOil: 1, remainingMileageCBSMessageEngineOil: 850 });
s.serviceHistory({ statusOperation: 0, dataSets: [] });
t += 1500; assert.strictEqual(s.flush(), true);
doc = JSON.parse(fs.readFileSync(path.join(dir, V.FILE), 'utf8'));
assert.strictEqual(doc.cbs[0].label, 'Motoröl'); assert.strictEqual(doc.serviceHistory.status, 'E_OK');
assert.ok(!fs.existsSync(path.join(dir, V.FILE + '.tmp')));
fs.rmSync(dir, { recursive: true, force: true });
// ReadOnlyDiag refuses anything but 0x19 02 and 0x22 (class pulled out of main.js and run).
const roSrc = src.slice(src.indexOf('class ReadOnlyDiag'), src.indexOf('mgu.run('));
const ReadOnlyDiag = new Function('Diag', roSrc + '; return ReadOnlyDiag;')(Diag);
(async () => {
    // Inject only the native binding and interface configuration; run the real
    // watch lifecycle. This source exposes a getter without an event notifier.
    const vm=require('node:vm'), signalSource=fs.readFileSync(path.join(root,'kit/runtime/signals.js'),'utf8');
    const events=[];
    let attempt=0,available;
    const proxy={init:async()=>{},subscribeToAvailability:fn=>{available=fn;},isAvailable:()=>false,
      getValue:async(field)=>{events.push(field);if(!attempt++)throw Error('fixture timeout');return {mileageKilometre:143352};},
      subscribe:()=>{throw Error('getter-only field was subscribed');}};
    const mod={exports:{}};
    vm.runInNewContext(signalSource,{module:mod,__dirname:path.join(root,'kit/runtime'),setImmediate,setInterval,clearInterval,
      require:name=>name==='someip'?{buildProxy:async()=>proxy}:name==='fs'?{readFileSync:()=>JSON.stringify({})}:require(name)});
    let result,err;
    const watch=await mod.exports.watch('de.bmw.infrastructure.VehicleInformation','1',{Range:v=>{result=v;}},null,
      {initialRead:true,readFields:['Range'],readOnlyFields:['Range'],onError:(field,stage)=>{err=field+' '+stage;}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepStrictEqual(events,['Range']);assert.strictEqual(err,'Range get');
    available(true);
    await new Promise(resolve=>setImmediate(resolve));
    assert.strictEqual(result.mileageKilometre,143352);
    await watch.shutdown();

    const sent = [];
    const d = new ReadOnlyDiag({ call: async (p, m, args) => { sent.push(args.serviceID); return 'NO_ERROR'; } }, { info() {}, warn() {} });
    d.p = {}; d.quiet = true;
    for (const [sid, data] of [[0x14, [0xFF, 0xFF, 0xFF]], [0x2E, [0xD0, 0x74, 1]], [0x31, [1, 2, 3]], [0x19, [0x01, 0xFF]], [0x10, [0x03]]]) {
        await assert.rejects(d.send(0x12, sid, data), /only reads/, 'refused 0x' + sid.toString(16));
    }
    assert.strictEqual(await d.send(0xDF, 0x19, [0x02, 0x0C]), 'NO_ERROR');
    assert.strictEqual(await d.send(0x12, 0x22, [0x44, 0xBE]), 'NO_ERROR');
    assert.deepStrictEqual(sent, [0x19, 0x22], 'nothing refused reached the transport');

    // Check-control messages
    let t = 1000;
    const f = new F.FaultState(() => t);
    assert.strictEqual(f.ccEvent({ ccmId: 0, activeState: 'AKTIV' }), null);
    f.ccEvent({ ccmId: 220, reason: 'CCM_REQUESTED_BY_ECU', requestorDiagAddr: 0x40, timeStamp_s: 5, activeState: 'AKTIV' });
    t = 2000; f.ccEvent({ ccmId: 220, reason: 2, requestorDiagAddr: 0x40, activeState: 0 });
    f.ccEvent({ ccmId: 39, reason: 0, requestorDiagAddr: 0x12, activeState: 'AKTIV' });
    assert.ok(f.needsText(220));
    assert.deepStrictEqual(f.ccText({ cCMessageWithSymbol: { cCMessage: { cCIdentifier: 220, cCName: 'Kühlmittelstand zu niedrig\u0000', additionalDescription: 'Kühlmittel nachfüllen.' } } }), { id: 220, text: 'Kühlmittelstand zu niedrig', description: 'Kühlmittel nachfüllen.' });
    assert.ok(F.decodeCcText({ cCMessageStruct: { cCIdentifier: 39, cCName: 'Motorstörung' } }));
    f.ccText({ requestedCCMessage: { cCMessageStruct: { cCIdentifier: 39, cCName: 'Motorstörung' } } });
    let doc = f.document();
    assert.deepStrictEqual(doc.checkControl.active.map((c) => [c.id, c.text, c.ecu]), [[220, 'Kühlmittelstand zu niedrig', 0x40], [39, 'Motorstörung', 0x12]]);
    assert.strictEqual(doc.checkControl.active[0].since, new Date(1000).toISOString(), 'repeated AKTIV keeps the first time');
    t = 3000; f.ccEvent({ ccmId: 220, activeState: 'INAKTIV' });
    doc = f.document();
    assert.deepStrictEqual(doc.checkControl.active.map((c) => c.id), [39]);
    assert.deepStrictEqual(doc.checkControl.events.map((e) => [e.id, e.active]), [[220, true], [39, true], [220, false]]);

    assert.deepStrictEqual(f.ccList([{cCListElement:{cCIdentifer:12}},{cCListElement:{cCIdentifer:39}}]),[12,39]);
    assert.strictEqual(f.ccList([{invalid:true}]),null);
    assert.deepStrictEqual(f.document().checkControl.active.map(c=>c.id),[39,12]);
    t=4000;f.ccList([]);
    assert.strictEqual(f.document().checkControl.active.length,0);
    assert.strictEqual(f.document().checkControl.listAt,new Date(4000).toISOString());
    assert.ok(f.document().checkControl.events.some(e=>e.id===12&&e.active===false));
    assert.strictEqual(F.decodeCcText({cCMessageStruct:{cCIdentifier:12}}),null);
    assert.strictEqual(F.decodeTyres({tpmsInternalLastPositionId1:0,tpmsInternalLastTemperatureDegCId1:-3})[0].temperatureC,-3);

    // Tyres (mbar and degC as the catalog's field names say)
    const w = f.setTyres({ tpmsInternalLastPositionId1: 'FRONT_LEFT', tpmsInternalLastPressureMbarId1: 2450, tpmsInternalLastTargetPressureMbarId1: 2500, tpmsInternalLastTemperatureDegCId1: 18, tpmsInternalLastBatteryStatusId1: 11,
        tpmsInternalLastPositionId2: 1, tpmsInternalLastPressureMbarId2: 65535, tpmsInternalLastPositionId3: 'SIGNAL_UNBEFUELLT', tpmsInternalLastPositionId4: 3, tpmsInternalLastPressureMbarId4: 2210, tpmsInternalLastTargetPressureMbarId4: 2700 });
    assert.deepStrictEqual(w.map((x) => [x.position, x.pressureBar, x.targetBar, x.temperatureC, x.battery]),
        [['FRONT_LEFT', 2.45, 2.5, 18, 'OK'], ['FRONT_RIGHT', null, null, null, null], ['REAR_RIGHT', 2.21, 2.7, null, null]]);

    // Fault memory: 59 02 <mask> then 4-byte records
    const replies = new Map([[0x12, [0x59, 0x02, 0xFF, 0x48, 0x0A, 0x12, 0x09, 0x02, 0x1A, 0x13, 0x08]], [0x40, [0x59, 0x02, 0xFF]], [0x63, [0x7F, 0x19, 0x22]]]);
    const r = f.setDtc('req-1', replies, [0x02, 0x0C], null);
    assert.deepStrictEqual(r.dtcs.map((d) => [d.address, d.code, d.label, d.active]), [['0x12', '021A13', 'STORED', false], ['0x12', '480A12', 'ACTIVE', true]]);
    assert.deepStrictEqual(r.ecus.map((e) => [e.address, e.ok, e.count, e.nrc]), [['0x12', true, 2, null], ['0x40', true, 0, null], ['0x63', false, 0, '0x22']]);
    assert.strictEqual(f.setDtc('req-2', null, [0x02, 0x0C], new Error('transport refused: BUSY')).error, 'Error: transport refused: BUSY');

    // DPF values and the combined snapshot
    f.setDpf('soot', 12.34567); f.setDpf('ash', NaN);
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vd2-'));
    const s2 = new V.VehicleSnapshot({ dir: dir2, version: '0.2.0', now: () => 5000 });
    s2.extra = () => f.document();
    assert.ok(s2.flush(true));
    const d2 = JSON.parse(fs.readFileSync(path.join(dir2, V.FILE), 'utf8'));
    assert.strictEqual(d2.dpf.soot, 12.346); assert.ok(!('ash' in d2.dpf));
    assert.strictEqual(d2.faultMemory.requestId, 'req-2'); assert.strictEqual(d2.tyres.wheels.length, 3);
    assert.strictEqual(d2.checkControl.active.length,0);
    fs.rmSync(dir2, { recursive: true, force: true });
    console.log('vehicle_data: read-only manifest and diagnostics, mileage, CBS, service history, check-control, tyres, fault memory, DPF and snapshot passed');
})().catch((e) => { console.error(e); process.exitCode = 1; });
