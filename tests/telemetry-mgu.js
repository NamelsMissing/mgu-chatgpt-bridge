'use strict';
// Vehicle Data telemetry on the MGU: decoding, aggregation, trip detection, offline buffer.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../apps/vehicle_data/telemetry.js');
const { drive, RAW, IF } = require('./fixtures/synthetic-drive');
const CATALOG = T.CATALOG;
const def = (id) => CATALOG.signals.find((s) => s.id === id);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-mgu-'));
const T0 = Date.UTC(2026, 10, 27, 7, 0, 0);
let passed = 0;
function test(name, fn) { fn(); passed++; }

function recorder(dir, clock, config) {
    return new T.TelemetryRecorder({ dataDir: dir, now: () => clock.t, config });
}
function packets(dir) {
    const d = path.join(dir, T.DIR);
    return fs.readdirSync(d).filter((n) => T.PACKET_NAME.test(n)).sort().map((n) => JSON.parse(fs.readFileSync(path.join(d, n), 'utf8')));
}
/** Feed the synthetic drive, ticking once a second in between. */
function runDrive(r, clock, start, opts) {
    const feed = [];
    const facts = drive(start, (iface, field, raw, t) => feed.push([t, iface, field, raw]), opts);
    feed.sort((a, b) => a[0] - b[0]);
    let nextTick = Math.ceil(feed[0][0] / 1000) * 1000;
    for (const [t, iface, field, raw] of feed) {
        while (nextTick <= t) { clock.t = nextTick; r.tick(); nextTick += 1000; }
        clock.t = t;
        r.ingest(iface, field, raw);
    }
    return { facts, nextTick };
}
function tickUntil(r, clock, until) { while (clock.t < until) { clock.t += 1000; r.tick(); } }

// ---------- Catalog ----------
test('catalog entries are complete and unique', () => {
    const ids = new Set();
    for (const s of CATALOG.signals) {
        assert.ok(!ids.has(s.id), 'unique ' + s.id); ids.add(s.id);
        for (const k of ['nameDe', 'nameEn', 'category', 'iface', 'field', 'member', 'type', 'kind', 'verification', 'source']) assert.ok(typeof s[k] === 'string' && s[k], s.id + '.' + k);
        assert.ok(['reference', 'unverified', 'vehicle'].includes(s.verification));
        if (s.kind === 'numeric') {
            for (const k of ['factor', 'offset', 'min', 'max', 'intervalMs']) assert.ok(Number.isFinite(s[k]), s.id + '.' + k);
            assert.ok(Array.isArray(s.invalid));
            assert.ok(s.intervalMs >= 2000, 'MGU load: at most one bucket per 2 s');
        } else assert.ok(s.items && typeof s.items === 'object');
        if (s.unit === 'raw') assert.strictEqual(s.verification, 'unverified', 'raw values are never presented as confirmed');
    }
    // The Pi carries the same catalog.
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(__dirname, '../pi-source/telemetry-catalog.json'), 'utf8')), JSON.parse(JSON.stringify(CATALOG)));
    // Every catalog field is subscribed (s) in the manifest, nothing more.
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '../apps/vehicle_data/app.json'), 'utf8'));
    for (const s of CATALOG.signals) assert.strictEqual(spec.signals[s.iface][s.field], 's', s.iface + '.' + s.field);
});

// ---------- Decoding ----------
test('decoding, scaling, invalid values, ranges and enums', () => {
    assert.deepStrictEqual(T.decode(def('speed'), RAW.speed(100)), { valid: true, value: 100 });
    assert.strictEqual(T.decode(def('speed'), { speedVehicleCentreOfGravity: 65535 }).reason, 'invalid_value');
    assert.strictEqual(T.decode(def('speed'), {}).reason, 'unexpected_shape_or_type');
    assert.strictEqual(T.decode(def('speed'), null).reason, 'unexpected_shape_or_type');
    assert.strictEqual(T.decode(def('speed'), { speedVehicleCentreOfGravity: '6400' }).reason, 'unexpected_shape_or_type');
    assert.strictEqual(T.decode(def('speed'), { speedVehicleCentreOfGravity: 64000 }).reason, 'out_of_range', '1000 km/h');
    assert.strictEqual(T.decode(def('rpm'), RAW.rpm(2000)).value, 2000);
    assert.strictEqual(T.decode(def('torque'), { actualValueTorqueCrankshaft: 2047 }).value, 0, 'raw 2047 = 0 Nm');
    assert.strictEqual(T.decode(def('torque'), { actualValueTorqueCrankshaft: 2447 }).value, 200);
    assert.strictEqual(T.decode(def('torque'), { actualValueTorqueCrankshaft: 4095 }).reason, 'invalid_value');
    assert.strictEqual(T.decode(def('coolant'), RAW.temps(90, 100)).value, 90);
    assert.strictEqual(T.decode(def('oil'), RAW.temps(90, 100)).value, 100);
    assert.strictEqual(T.decode(def('oil'), { temperatureEngineOilDrive: 255 }).reason, 'invalid_value');
    assert.strictEqual(T.decode(def('accelLong'), RAW.accelLong(-9.81)).value, -9.81);
    assert.strictEqual(T.decode(def('odometer'), RAW.tank(143350)).value, 143350);
    assert.strictEqual(T.decode(def('odometer'), RAW.tank(0)).reason, 'invalid_value');
    assert.strictEqual(T.decode(def('odometer'), RAW.tank(0xFFFFFFFF)).reason, 'invalid_value');
    assert.strictEqual(T.decode(def('fuelLevelRaw'), RAW.tank(1)).value, 40, 'raw stays raw');
    assert.deepStrictEqual(T.decode(def('gear'), { statusActualGearDrive: 'G3' }), { valid: true, value: 5, name: 'G3' });
    assert.deepStrictEqual(T.decode(def('gear'), { statusActualGearDrive: 5 }), { valid: true, value: 5, name: 'G3' }, 'wire number');
    assert.strictEqual(T.decode(def('gear'), { statusActualGearDrive: 'SIGNAL_UNBEFUELLT' }).valid, false);
    assert.strictEqual(T.decode(def('gear'), { statusActualGearDrive: 'G99' }).reason, 'unexpected_shape_or_type');
    assert.strictEqual(T.decode(def('condition'), RAW.condition('FAHREN')).name, 'FAHREN');
    const unqualified = Object.assign(RAW.condition('FAHREN'), { qualifierStatusConditionVehicle: 'WERT_NICHT_VERFUEGBAR' });
    assert.strictEqual(T.decode(def('condition'), unqualified).reason, 'qualifier_invalid');
    assert.strictEqual(T.decode(def('condition'), Object.assign(RAW.condition('FAHREN'), { qualifierStatusConditionVehicle: 2 })).valid, true, 'qualifier as number');
});
// Raw 0 = -48 °C, below the plausible -40 °C.
test('temperatures below the plausible range are rejected', () => {
    assert.strictEqual(T.decode(def('coolant'), { temperatureEngineDrive: 0 }).reason, 'out_of_range');
});

// ---------- Aggregation ----------
test('time-weighted mean, kept peaks, held values and gaps', () => {
    const out = [];
    const a = new T.Aggregator({ id: 'x', intervalMs: 2000 }, 30000);
    a.add(0, 1000, out);      // bucket 0..2000
    a.add(100, 1500, out);    // 0 for 500 ms, then 100
    a.add(50, 1900, out);     // a 400 ms peak of 100
    a.roll(2000, out);
    assert.strictEqual(out.length, 1);
    const [id, start, covered, mean, min, max, last, n] = out[0];
    assert.deepStrictEqual([id, start, covered, min, max, last, n], ['x', 0, 1000, 0, 100, 50, 3]);
    assert.strictEqual(mean, (0 * 500 + 100 * 400 + 50 * 100) / 1000, 'time-weighted, not the sample mean');
    a.roll(6000, out);         // held value fills the next buckets
    assert.deepStrictEqual(out.slice(1).map((r) => [r[1], r[2], r[3], r[7]]), [[2000, 2000, 50, 0], [4000, 2000, 50, 0]]);
    a.cut(7000, out);          // provider lost: the bucket ends where the data ends
    assert.deepStrictEqual(out[3].slice(1, 4), [6000, 1000, 50]);
    a.roll(20000, out);
    assert.strictEqual(out.length, 4, 'no rows after a gap');
    const short = new T.Aggregator({ id: 'z', intervalMs: 2000 }, 600000);
    const shortRows = [];
    short.long = false;
    short.add(5, 0, shortRows);
    short.roll(100000, shortRows);
    assert.strictEqual(shortRows.reduce((s2, r) => s2 + r[2], 0), 30000, 'outside a trip a value holds 30 s');
    const held = new T.Aggregator({ id: 'y', intervalMs: 2000 }, 3000);
    const rows = [];
    held.add(10, 0, rows);
    held.roll(10000, rows);
    assert.deepStrictEqual(rows.map((r) => [r[1], r[2]]), [[0, 2000], [2000, 1000]], 'the hold limit cuts the value');
});

// ---------- Synthetic drive ----------
test('synthetic drive: one trip from cold start to parking, start-stop and coasting keep it', () => {
    const dir = tmp(), clock = { t: T0 - 30000 };
    const r = recorder(dir, clock);
    const { facts } = runDrive(r, clock, T0);
    tickUntil(r, clock, facts.end + 60000);
    r.flush(true);
    const all = packets(dir);
    const events = [].concat.apply([], all.map((p) => p.events));
    assert.deepStrictEqual(events.map((e) => e.type), ['trip_start', 'trip_end'], 'one trip despite 6 town stops with the engine off');
    assert.strictEqual(events[0].at, T0, 'starts with readiness (warm-up idle included)');
    assert.strictEqual(events[1].reason, 'parked');
    assert.ok(events[1].at >= facts.end && events[1].at <= facts.end + 2000, 'ends when readiness ended, not when parking was confirmed');
    assert.strictEqual(events[0].odo, 143350);
    assert.strictEqual(events[1].trip, events[0].trip);
    const rows = [].concat.apply([], all.map((p) => p.rows));
    const speed = rows.filter((x) => x[0] === 'speed');
    const vmax = Math.max.apply(null, speed.map((x) => x[5]));
    assert.ok(Math.abs(vmax - facts.vmax) < 0.1, 'max speed kept through aggregation: ' + vmax);
    const km = speed.reduce((s, x) => s + x[3] * x[2] / 3600000, 0);
    assert.ok(Math.abs(km - facts.distanceKm) / facts.distanceKm < 0.01, 'integrated distance ' + km + ' vs ' + facts.distanceKm);
    assert.ok(speed.length <= 1440 / 2 + 40, 'one row per 2 s: ' + speed.length);
    assert.ok(rows.some((x) => x[0] === 'sailing' && x[3] === 3), 'coasting recorded as enum');
    assert.ok(rows.every((x) => x.length === 8 && Number.isFinite(x[1]) && x[2] >= 0));
    const oil = rows.filter((x) => x[0] === 'oil');
    assert.strictEqual(Math.max.apply(null, oil.map((x) => x[5])), facts.maxOil);
    assert.ok(all.every((p) => p.schema === 1 && p.clockPlausible === true && typeof p.packetId === 'string'));
    assert.strictEqual(new Set(all.map((p) => p.packetId)).size, all.length, 'unique packet ids');
    const bytesPerHour = all.reduce((s, p) => s + JSON.stringify(p).length, 0) / (24 / 60);
    assert.ok(bytesPerHour < 1.5 * 1024 * 1024, 'data volume ' + Math.round(bytesPerHour / 1024) + ' KiB per hour');
    global.TELEMETRY_VOLUME = Math.round(bytesPerHour / 1024);
    const status = r.status();
    assert.strictEqual(status.trip, null);
    assert.ok(status.signals.speed.valid > 7000);
});

test('a long stop with no speed notification stays covered during a trip', () => {
    const dir = tmp(), clock = { t: T0 };
    const r = recorder(dir, clock);
    for (let s = 0; s < 60; s++) { clock.t = T0 + s * 1000; r.ingest(IF.speed[0], IF.speed[1], RAW.speed(40 - Math.min(40, s))); r.tick(); }
    // 0 km/h is reported once; the car then waits 4 minutes at a light without new notifications.
    tickUntil(r, clock, T0 + 60000 + 240000);
    r.ingest(IF.speed[0], IF.speed[1], RAW.speed(10));
    r.flush(true);
    const rows = [].concat.apply([], packets(dir).map((p) => p.rows)).filter((x) => x[0] === 'speed');
    const covered = rows.reduce((s, x) => s + x[2], 0);
    assert.ok(covered >= 299000, 'covered ' + covered + ' of 300000 ms');
});

test('trip without vehicle-condition signal ends after the standstill limit', () => {
    const dir = tmp(), clock = { t: T0 };
    const r = recorder(dir, clock);
    const speed = (kmh) => r.ingest(IF.speed[0], IF.speed[1], RAW.speed(kmh));
    for (let s = 0; s < 120; s++) { clock.t = T0 + s * 1000; speed(s < 100 ? 50 : 0); r.tick(); }
    assert.ok(r.trips.trip, 'started by speed');
    assert.strictEqual(r.trips.trip.startAt, T0, 'start at the first moving sample');
    tickUntil(r, clock, T0 + 99000 + 9 * 60000);
    assert.ok(r.trips.trip, 'a 9 min stop keeps the trip');
    tickUntil(r, clock, T0 + 99000 + 10 * 60000 + 1000);
    assert.strictEqual(r.trips.trip, null);
    r.flush(true);
    const end = [].concat.apply([], packets(dir).map((p) => p.events)).find((e) => e.type === 'trip_end');
    assert.strictEqual(end.reason, 'idle_timeout');
    assert.strictEqual(end.at, T0 + 99000, 'ends at the last movement');
});

test('engine running without moving (heating up, aux heating) is no trip', () => {
    const dir = tmp(), clock = { t: T0 };
    const r = recorder(dir, clock);
    r.ingest(IF.condition[0], IF.condition[1], RAW.condition('WOHNEN'));
    for (let s = 0; s < 900; s++) {
        clock.t = T0 + s * 1000;
        r.ingest(IF.rpm[0], IF.rpm[1], RAW.rpm(780));
        r.ingest(IF.speed[0], IF.speed[1], RAW.speed(0));
        r.tick();
    }
    assert.strictEqual(r.trips.trip, null);
    // A brief speed glitch (< 5 s) does not start a trip either.
    for (let s = 0; s < 3; s++) { clock.t += 1000; r.ingest(IF.speed[0], IF.speed[1], RAW.speed(8)); r.tick(); }
    clock.t += 1000; r.ingest(IF.speed[0], IF.speed[1], RAW.speed(0)); r.tick();
    assert.strictEqual(r.trips.trip, null);
});

test('odometer step starts a trip when speed is missing', () => {
    const dir = tmp(), clock = { t: T0 };
    const r = recorder(dir, clock);
    r.ingest(IF.tank[0], IF.tank[1], RAW.tank(1000));
    clock.t += 60000;
    r.ingest(IF.tank[0], IF.tank[1], RAW.tank(1001));
    assert.ok(r.trips.trip);
    assert.strictEqual(r.trips.trip.reason, 'odometer');
    assert.strictEqual(r.trips.trip.startOdo, 1000);
    clock.t += 60000;
    r.ingest(IF.tank[0], IF.tank[1], RAW.tank(1500));
    assert.strictEqual(r.trips.lastOdo, 1500, 'a jump is taken as the new reading but is no movement');
});

test('speed spikes are rejected, real acceleration is kept', () => {
    const dir = tmp(), clock = { t: T0 };
    const r = recorder(dir, clock);
    const feed = (kmh) => { clock.t += 200; r.ingest(IF.speed[0], IF.speed[1], RAW.speed(kmh)); };
    feed(50); feed(51); feed(250); feed(52); feed(53.5);
    assert.strictEqual(r.counters.spikes, 1);
    r.flush(true);
    tickUntil(r, clock, clock.t + 3000);
    r.flush(true);
    const rows = [].concat.apply([], packets(dir).map((p) => p.rows)).filter((x) => x[0] === 'speed');
    assert.ok(rows.length && Math.max.apply(null, rows.map((x) => x[5])) < 60);
    // 0 -> 100 km/h in 6 s (4.6 m/s²) passes.
    const r2 = recorder(tmp(), clock);
    for (let i = 0; i <= 30; i++) { clock.t += 200; r2.ingest(IF.speed[0], IF.speed[1], RAW.speed(i * 100 / 30)); }
    assert.strictEqual(r2.counters.spikes, 0);
});

test('MGU restart: a recent trip continues, an old one is closed at its last activity', () => {
    const dir = tmp(), clock = { t: T0 };
    let r = recorder(dir, clock);
    for (let s = 0; s < 60; s++) { clock.t = T0 + s * 1000; r.ingest(IF.speed[0], IF.speed[1], RAW.speed(60)); r.tick(); }
    const id = r.trips.trip.id;
    r.persist();
    clock.t += 90000;                       // MGU reboots while the car stands at a light
    r = recorder(dir, clock);
    assert.strictEqual(r.trips.trip.id, id, 'resumed');
    r.flush(true);
    let ev = [].concat.apply([], packets(dir).map((p) => p.events));
    assert.ok(ev.some((e) => e.type === 'trip_resume' && e.trip === id));
    r.persist();
    clock.t += 3600000;                     // next start an hour later
    r = recorder(dir, clock);
    assert.strictEqual(r.trips.trip, null);
    r.flush(true);
    ev = [].concat.apply([], packets(dir).map((p) => p.events));
    const end = ev.find((e) => e.type === 'trip_end');
    assert.strictEqual(end.trip, id);
    assert.strictEqual(end.reason, 'restart_timeout');
    assert.strictEqual(end.at, T0 + 59000);
});

test('offline buffer: atomic files, bounded size, trip events outlive samples', () => {
    const dir = tmp(), clock = { t: T0 };
    const r = recorder(dir, clock, { bufferBytes: 60 * 1024, maxFiles: 50 });
    fs.writeFileSync(path.join(dir, T.DIR, '.p-0000000000000-000001-deadbeef.json.tmp'), '{"half');
    r.trips.start(T0, 'speed');
    for (let k = 0; k < 200; k++) r.rows.push(['speed', T0 + k, 2000, 50, 49, 51, 50, 4]);
    r.flush(true);
    for (let i = 0; i < 40; i++) {
        clock.t += 30000;
        for (let k = 0; k < 200; k++) r.rows.push(['speed', clock.t + k, 2000, 50, 49, 51, 50, 4]);
        r.flush();
    }
    const files = fs.readdirSync(path.join(dir, T.DIR)).filter((n) => T.PACKET_NAME.test(n));
    const bytes = files.reduce((s, n) => s + fs.statSync(path.join(dir, T.DIR, n)).size, 0);
    assert.ok(bytes <= 60 * 1024, 'bounded: ' + bytes);
    const all = packets(dir);
    assert.ok(all.some((p) => p.truncated && p.events.some((e) => e.type === 'trip_start') && !p.rows.length), 'trip start kept, samples dropped');
    assert.ok(r.store.dropped > 0);
    assert.ok(all.every((p) => p.rows.every((x) => x.length === 8)), 'the half-written temp file is never read as a packet');
    assert.ok(r.status().buffer.pending === files.length);
});

test('recording can be switched off from the Pi; settings are bounded', () => {
    const dir = tmp(), clock = { t: T0 };
    const r = recorder(dir, clock);
    for (let s = 0; s < 30; s++) { clock.t = T0 + s * 1000; r.ingest(IF.speed[0], IF.speed[1], RAW.speed(40)); r.tick(); }
    assert.ok(r.trips.trip);
    fs.writeFileSync(path.join(dir, T.CONFIG_FILE), JSON.stringify({ enabled: false, idleEndMin: 1, bufferMb: 5000 }));
    tickUntil(r, clock, clock.t + 31000);
    assert.strictEqual(r.config.enabled, false);
    assert.strictEqual(r.trips.trip, null, 'trip closed when recording is switched off');
    assert.strictEqual(r.config.idleEndMs, T.DEFAULTS.idleEndMs, 'out-of-range idle limit ignored');
    assert.strictEqual(r.config.bufferBytes, T.DEFAULTS.bufferBytes, 'out-of-range buffer ignored');
    const before = r.counters.received;
    r.ingest(IF.speed[0], IF.speed[1], RAW.speed(40));
    assert.strictEqual(r.counters.received, before, 'nothing recorded while off');
    fs.writeFileSync(path.join(dir, T.CONFIG_FILE), JSON.stringify({ enabled: true, idleEndMin: 15, bufferMb: 10 }));
    tickUntil(r, clock, clock.t + 31000);
    assert.strictEqual(r.config.idleEndMs, 15 * 60000);
    assert.strictEqual(r.config.bufferBytes, 10 * 1024 * 1024);
});

test('provider loss closes held values', () => {
    const dir = tmp(), clock = { t: T0 };
    const r = recorder(dir, clock);
    r.ingest(IF.temps[0], IF.temps[1], RAW.temps(80, 90));
    clock.t += 5000;
    r.availability(IF.temps[0], false);
    tickUntil(r, clock, clock.t + 60000);
    r.flush(true);
    const rows = [].concat.apply([], packets(dir).map((p) => p.rows)).filter((x) => x[0] === 'oil');
    assert.strictEqual(rows.reduce((s, x) => s + x[2], 0), 5000, 'covered time ends at the loss');
});

console.log('Telemetry MGU: catalog, decoding, aggregation, trips (start-stop, coasting, restart), spikes, buffer and settings passed (' + passed + ' groups, ~' + global.TELEMETRY_VOLUME + ' KiB per driving hour).');
