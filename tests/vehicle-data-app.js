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

// Read-only: no setter flags, no CBS reset, no UDS transport.
for (const [iface, fields] of Object.entries(spec.signals)) {
    for (const [k, v] of Object.entries(fields)) if (!k.startsWith('_')) assert.ok(!/w/.test(v), iface + '.' + k + ' must not be writable');
}
assert.ok(!('cBSReset' in spec.signals['de.bmw.infotainment.ConditionBasedServicesLegacy']));
assert.ok(!Object.keys(spec.signals).some((i) => /Tasu/.test(i)), 'no UDS transport');
assert.ok(!/signals\.set\(|cBSReset|sendTasuRequest/.test(src), 'nothing is written to the car');
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
console.log('vehicle_data: read-only manifest, mileage, CBS, service history and snapshot passed');
