'use strict';
// Runs the real Vehicle Data main.js in the package layout with a fake kit and fake SOME/IP,
// and checks the telemetry wiring: notifier subscriptions only, no getters, values reach
// the recorder, provider loss reaches the recorder, status reaches the snapshot.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const { RAW, IF } = require('./fixtures/synthetic-drive');

const app = fs.mkdtempSync(path.join(os.tmpdir(), 'vehicle-wiring-')), js = path.join(app, 'source', 'javascript');
fs.mkdirSync(path.join(js, 'kit'), { recursive: true });
fs.mkdirSync(path.join(app, 'data'));
for (const f of fs.readdirSync(path.join(root, 'apps/vehicle_data'))) {
    if (f.endsWith('.js')) fs.copyFileSync(path.join(root, 'apps/vehicle_data', f), path.join(js, f === 'main.js' ? 'app.js' : f));
}
const manifest = JSON.parse(execFileSync('python3', ['-c',
    'import json,sys;sys.path.insert(0,"kit/tools");from build import manifest_for;print(json.dumps(manifest_for(json.load(open("apps/vehicle_data/app.json")))))'], { cwd: root }));
fs.writeFileSync(path.join(app, 'source', 'manifest.json'), JSON.stringify(manifest));
fs.writeFileSync(path.join(js, 'kit', 'mgu.js'), 'module.exports={run:(a)=>{global.VEHICLE_APP=a;}};');
fs.writeFileSync(path.join(js, 'kit', 'gauges.js'), 'module.exports={frame(){}};');
fs.writeFileSync(path.join(js, 'kit', 'diag.js'), 'class Diag{constructor(){this.error="offline";}async init(){}on(){}}module.exports={Diag};');
fs.writeFileSync(path.join(js, 'kit', 'dids.js'), 'class DidReader{}module.exports={DidReader};');

const watched = [];
const signals = {
    watch(iface, instance, handlers, log, opts) {
        const entry = { iface, instance, fields: Object.keys(handlers), handlers, opts: opts || {} };
        watched.push(entry);
        if (entry.opts.onAvailability) entry.opts.onAvailability(true);
        return Promise.resolve({ available: true, error: null, proxy: {}, shutdown: () => Promise.resolve() });
    },
    proxy: () => Promise.reject(new Error('offline')),
    call: () => Promise.reject(new Error('offline')),
    on: () => Promise.resolve(),
};
const canvas = { clear() { return canvas; }, text() {}, roundRect() {} };
const ctx = {
    ui: { onClick() {}, image: () => Promise.resolve() }, log: { info() {}, warn() {} }, signals,
    canvas: () => canvas, loop() {}, theme: () => ({}), spec: { version: 'test' },
};
require(path.join(js, 'app.js'));
global.VEHICLE_APP.start(ctx);

setTimeout(() => {
    const T = require(path.join(js, 'telemetry.js'));
    const telemetry = watched.filter((w) => w.opts.onTrace && !w.opts.readFields && !w.opts.pollMs && T.CATALOG.signals.some((s) => s.iface === w.iface));
    const wanted = {};
    T.CATALOG.signals.forEach((s) => { (wanted[s.iface] = wanted[s.iface] || new Set()).add(s.field); });
    assert.deepStrictEqual(new Set(telemetry.map((w) => w.iface)), new Set(Object.keys(wanted)), 'one telemetry watch per interface');
    for (const w of telemetry) {
        assert.deepStrictEqual(new Set(w.fields), wanted[w.iface], w.iface);
        assert.ok(!w.opts.readFields && !w.opts.initialRead && !w.opts.pollMs, 'no getter, no polling: ' + w.iface);
        assert.strictEqual(w.instance, '1');
    }
    // The old Range getter stays unrequested although VehicleInformation is now declared.
    const range = watched.find((w) => w.iface === 'de.bmw.infrastructure.VehicleInformation' && w.fields.includes('Range'));
    assert.ok(!range, 'Range getter is not declared, so it is not watched');
    // Feed a few notifications through the real handlers.
    const fire = (key, raw) => telemetry.find((w) => w.iface === IF[key][0]).handlers[IF[key][1]](raw, 'event');
    for (let i = 0; i < 12; i++) fire('speed', RAW.speed(30 + i));
    fire('temps', RAW.temps(70, 75));
    fire('condition', RAW.condition('FAHREN'));
    telemetry.find((w) => w.iface === IF.temps[0]).opts.onAvailability(false);
    setTimeout(() => {
        const state = JSON.parse(fs.readFileSync(path.join(app, 'data', 'bmw-vehicle-data.json'), 'utf8'));
        assert.ok(state.recorder && state.recorder.schema === 1, 'recorder status in the snapshot');
        assert.ok(fs.existsSync(path.join(app, 'data', 'telemetry')), 'packet directory created');
        assert.ok(fs.existsSync(path.join(app, 'data', 'telemetry-state.json')), 'trip state persisted');
        const stages = state.telemetry.stages;
        assert.strictEqual(stages['Telemetry.CDS'].provider, false, 'provider loss recorded');
        assert.deepStrictEqual([stages['Telemetry.CDS.statusEngineSpeed2'].manifestRead, stages['Telemetry.CDS.statusEngineSpeed2'].manifestSubscribe,
            stages['Telemetry.CDS.statusEngineSpeed2'].provider], [false, true, false], 'per-field diagnostics for the website');
        assert.strictEqual(stages['Telemetry.Vehicle2.statusCarSpeed2'].provider, true);
        console.log('Vehicle Data telemetry wiring: notifier-only watches for ' + telemetry.length + ' interfaces, handlers, availability and snapshot passed.');
        process.exit(0);
    }, 21500);
}, 300);
