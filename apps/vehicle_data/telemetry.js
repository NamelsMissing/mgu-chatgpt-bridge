'use strict';
/*
 * Vehicle Data telemetry: decoding, time-weighted aggregation, trip detection and the
 * offline packet buffer. Runs on the MGU (Node 8.7): no optional chaining, no ??, no
 * object spread, no optional catch binding.
 *
 * The MGU only collects. Long-term storage, statistics and charts live on the Pi.
 *
 *   SOME/IP notifier -> decode() -> Aggregator (one bucket per signal and interval:
 *   time-weighted mean, min, max, last, sample count) -> packet file in data/telemetry/
 *   -> companion agent -> Pi (acknowledges each packet id, then the agent deletes it).
 *
 * Fields are notified on change, so a value holds until the next notification, but only
 * for holdMs and only while the provider is available. Gaps stay gaps.
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var CATALOG = require('./telemetry_catalog.js');

var PACKET_SCHEMA = 1;
var DIR = 'telemetry';
var STATE_FILE = 'telemetry-state.json';
var CONFIG_FILE = 'bmw-telemetry-config.json';
var PACKET_NAME = /^p-(\d{13})-(\d{6})-([0-9a-f]{8})\.json$/;
var DEFAULTS = {
    enabled: true,
    idleEndMs: 10 * 60000,      // standstill without engine, readiness or movement ends a trip
    parkConfirmMs: 30000,       // a reported parked state must hold this long
    startSpeedKmh: 3,
    startHoldMs: 5000,          // moving above startSpeedKmh this long starts a trip
    flushMs: 30000,             // one packet at most every 30 s
    maxPacketRows: 1500,
    bufferBytes: 20 * 1024 * 1024,
    maxFiles: 4000,
    maxAccelMs2: 15,            // a speed change faster than this is a measurement error
};
var ACTIVE_CONDITIONS = { FAHREN: 1, FAHRBEREITSCHAFT_HERSTELLEN: 1 };
var PARKED_CONDITIONS = { PARKEN_BN_IO: 1, PARKEN_BN_NIO: 1, STANDFUNKTIONEN_KUNDE_NICHT_IM_FZG: 1, WOHNEN: 1, FAHRBEREITSCHAFT_BEENDEN: 1 };

function isNum(v) { return typeof v === 'number' && isFinite(v); }
function round(v, digits) { var f = Math.pow(10, digits); return Math.round(v * f) / f; }
function nameOf(items, code) {
    for (var k in items) if (items[k] === code) return k;
    return null;
}

/** Decode one catalog entry from the field's struct. -> {valid, value, name?, reason} */
function decode(def, raw) {
    var x = raw && typeof raw === 'object' ? raw[def.member] : undefined;
    if (def.kind === 'enum') {
        var code = typeof x === 'number' ? x : typeof x === 'string' && def.items.hasOwnProperty(x) ? def.items[x] : undefined;
        var name = typeof x === 'string' ? x : nameOf(def.items, code);
        if (!isNum(code) || name === null) return { valid: false, reason: 'unexpected_shape_or_type' };
        if (def.invalidItems && def.invalidItems.indexOf(name) !== -1) return { valid: false, value: code, name: name, reason: 'invalid_value' };
        if (def.qualifier) {
            var q = raw[def.qualifier];
            var qn = typeof q === 'string' ? q : nameOf(def.qualifierItems || {}, q);
            if (def.validQualifiers.indexOf(qn) === -1) return { valid: false, value: code, name: name, reason: 'qualifier_invalid' };
        }
        return { valid: true, value: code, name: name };
    }
    if (!isNum(x)) return { valid: false, reason: 'unexpected_shape_or_type' };
    if ((def.invalid && def.invalid.indexOf(x) !== -1) || (isNum(def.invalidFrom) && x >= def.invalidFrom)) return { valid: false, reason: 'invalid_value' };
    var v = x * def.factor + (def.offset || 0);
    if (v < def.min || v > def.max) return { valid: false, reason: 'out_of_range' };
    return { valid: true, value: round(v, 4) };
}

/**
 * Time-weighted buckets aligned to the signal's interval. The held value counts until the
 * next sample, until holdMs has passed, or until the signal is marked unavailable.
 */
function Aggregator(def, holdMs) {
    this.def = def;
    this.interval = def.intervalMs;
    this.holdMs = holdMs;
    this.last = null;           // {v, t}: value that currently holds
    this.bucket = null;
}
Aggregator.prototype._open = function (start) {
    this.bucket = { start: start, integral: 0, covered: 0, min: null, max: null, n: 0 };
};
Aggregator.prototype._integrate = function (to) {
    var b = this.bucket, l = this.last;
    if (!b || !l) return;
    var from = Math.max(b.start, l.t), until = Math.min(to, l.t + this.holdMs, b.start + this.interval);
    if (until <= from) return;
    b.integral += l.v * (until - from);
    b.covered += until - from;
    if (b.min === null || l.v < b.min) b.min = l.v;
    if (b.max === null || l.v > b.max) b.max = l.v;
};
Aggregator.prototype._close = function (out) {
    var b = this.bucket;
    this.bucket = null;
    if (!b || (!b.covered && !b.n)) return;
    var mean = b.covered ? b.integral / b.covered : b.max;
    // [signal, bucket start (ms UTC), covered ms, time-weighted mean, min, max, last, samples]
    out.push([this.def.id, b.start, b.covered, round(mean, 4), b.min, b.max, this.last ? this.last.v : b.max, b.n]);
};
/** Close every bucket that ended at or before t. */
Aggregator.prototype.roll = function (t, out) {
    while (this.bucket && this.bucket.start + this.interval <= t) {
        var next = this.bucket.start + this.interval;
        this._integrate(next);
        this._close(out);
        if (this.last && this.last.t + this.holdMs > next) this._open(next);
    }
};
Aggregator.prototype.add = function (v, t, out) {
    this.roll(t, out);
    if (!this.bucket) this._open(Math.floor(t / this.interval) * this.interval);
    this._integrate(t);
    var b = this.bucket;
    b.n++;
    if (b.min === null || v < b.min) b.min = v;
    if (b.max === null || v > b.max) b.max = v;
    this.last = { v: v, t: t };
};
/** The provider went away: stop holding the value at t. */
Aggregator.prototype.cut = function (t, out) {
    this.roll(t, out);
    this._integrate(t);
    this.last = null;
    this._close(out);
};

/** Trip state from vehicle condition, speed, engine speed and odometer. */
function TripDetector(config, saved) {
    this.c = config;
    this.trip = null;           // {id, startAt, lastActiveAt, startOdo, reason}
    this.condition = null;      // {name, at} only while valid
    this.parkedSince = null;
    this.movingSince = null;
    this.readySince = null;     // readiness or engine running before the car moved (warm-up idle)
    this.speed = null;
    this.rpmPositiveAt = 0;
    this.lastOdo = null;
    this.events = [];
    if (saved && saved.trip && typeof saved.trip.id === 'string') this.saved = saved;
    if (saved && isNum(saved.lastOdo)) this.lastOdo = saved.lastOdo;
}
TripDetector.prototype._event = function (type, at, extra) {
    var e = { type: type, trip: this.trip.id, at: at, odo: this.lastOdo };
    for (var k in extra || {}) e[k] = extra[k];
    this.events.push(e);
};
TripDetector.prototype.start = function (at, reason) {
    if (this.trip) return;
    // Count the idle before moving off (cold start, defrosting) as part of the trip.
    if (this.readySince !== null && this.readySince <= at && at - this.readySince <= this.c.idleEndMs) at = this.readySince;
    this.trip = { id: 't' + at.toString(36) + '-' + crypto.randomBytes(3).toString('hex'), startAt: at, lastActiveAt: at, startOdo: this.lastOdo, reason: reason };
    this._event('trip_start', at, { reason: reason });
};
TripDetector.prototype.end = function (at, reason) {
    if (!this.trip) return;
    this._event('trip_end', Math.max(at, this.trip.startAt), { reason: reason, startAt: this.trip.startAt, startOdo: this.trip.startOdo });
    this.trip = null;
    this.movingSince = null;
    this.readySince = null;
};
TripDetector.prototype._active = function (t) { if (this.trip && t > this.trip.lastActiveAt) this.trip.lastActiveAt = t; };
/** After an MGU restart: continue a recent trip, close an old one at its last activity. */
TripDetector.prototype.restore = function (now) {
    var s = this.saved;
    this.saved = null;
    if (!s) return;
    this.trip = s.trip;
    if (now >= this.trip.lastActiveAt && now - this.trip.lastActiveAt < this.c.idleEndMs) this._event('trip_resume', now, {});
    else this.end(this.trip.lastActiveAt, 'restart_timeout');
};
TripDetector.prototype.speedSample = function (v, t) {
    this.speed = { v: v, t: t };
    if (v > this.c.startSpeedKmh) {
        if (this.movingSince === null) this.movingSince = t;
        if (!this.trip && t - this.movingSince >= this.c.startHoldMs) this.start(this.movingSince, 'speed');
        this._active(t);
    } else this.movingSince = null;
};
TripDetector.prototype.rpmSample = function (v, t) {
    if (v > 0) {
        if (this.readySince === null && !this.trip) this.readySince = t;
        this.rpmPositiveAt = t;
        this._active(t);
    }
};
TripDetector.prototype.odometerSample = function (km, t) {
    var moved = this.lastOdo !== null && km > this.lastOdo && km - this.lastOdo <= 5;
    if (moved) { if (!this.trip) this.start(t, 'odometer'); this._active(t); }
    // A trip that starts with this sample keeps the previous reading as its start.
    this.lastOdo = km;
};
TripDetector.prototype.conditionSample = function (d, t) {
    if (!d.valid) { this.condition = null; this.parkedSince = null; return; }
    this.condition = { name: d.name, at: t };
    if (ACTIVE_CONDITIONS[d.name]) {
        this.parkedSince = null;
        if (this.readySince === null && !this.trip) this.readySince = t;
        this._active(t);
    } else if (PARKED_CONDITIONS[d.name]) {
        if (this.parkedSince === null) this.parkedSince = t;
        if (!this.trip) this.readySince = null;
    }
    else this.parkedSince = null;
};
TripDetector.prototype.tick = function (now) {
    if (!this.trip) return;
    // Readiness or a running engine (also start-stop and coasting) keeps the trip.
    if (this.condition && ACTIVE_CONDITIONS[this.condition.name]) this._active(now);
    if (now - this.rpmPositiveAt < 30000) this._active(this.rpmPositiveAt);
    var still = !this.speed || this.speed.v <= this.c.startSpeedKmh;
    if (this.parkedSince !== null && still && now - this.parkedSince >= this.c.parkConfirmMs) this.end(this.trip.lastActiveAt, 'parked');
    else if (now - this.trip.lastActiveAt >= this.c.idleEndMs) this.end(this.trip.lastActiveAt, 'idle_timeout');
};
TripDetector.prototype.saveState = function () {
    return { trip: this.trip, lastOdo: this.lastOdo };
};

/** Packet files in data/telemetry/: written atomically, deleted by the agent after the Pi acknowledged them. */
function PacketStore(dir, config, now) {
    this.dir = dir;
    this.c = config;
    this.now = now;
    this.bootId = crypto.randomBytes(4).toString('hex');
    this.seq = 0;
    this.dropped = 0;
    this.writeErrors = 0;
    try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}
PacketStore.prototype.files = function () {
    var names;
    try { names = fs.readdirSync(this.dir); } catch (e) { return []; }
    return names.filter(function (n) { return PACKET_NAME.test(n); }).sort();
};
PacketStore.prototype.write = function (rows, events, meta) {
    if (!rows.length && !events.length) return null;
    var t = this.now(), seq = ++this.seq;
    var name = 'p-' + ('000000000000' + t).slice(-13) + '-' + ('00000' + seq).slice(-6) + '-' + this.bootId + '.json';
    var doc = { schema: PACKET_SCHEMA, packetId: this.bootId + '-' + seq + '-' + t, bootId: this.bootId, seq: seq,
        createdAt: new Date(t).toISOString(), catalogVersion: CATALOG.version, clockPlausible: t > Date.UTC(2025, 0, 1),
        meta: meta || {}, rows: rows, events: events };
    var file = path.join(this.dir, name), tmp = path.join(this.dir, '.' + name + '.tmp');
    try {
        fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 420 });
        fs.renameSync(tmp, file);
    } catch (e) {
        this.writeErrors++;
        try { fs.unlinkSync(tmp); } catch (ignored) { /* nothing to remove */ }
        throw e;
    }
    this.enforce();
    return doc.packetId;
};
/** Keep the buffer bounded: drop the oldest samples first, keep trip events as long as possible. */
PacketStore.prototype.enforce = function () {
    var self = this, names = this.files(), sizes = {}, total = 0;
    names.forEach(function (n) { try { sizes[n] = fs.statSync(path.join(self.dir, n)).size; } catch (e) { sizes[n] = 0; } total += sizes[n]; });
    var over = function (count) { return total > self.c.bufferBytes || count > self.c.maxFiles; };
    var count = names.length, newest = names[names.length - 1];
    // Pass 1: samples of the oldest packets. Pass 2: events-only packets, oldest first.
    for (var pass = 1; pass <= 2 && over(count); pass++) {
        for (var i = 0; i < names.length && over(count); i++) {
            var n = names[i], file = path.join(this.dir, n), doc = null;
            if (n === newest || !sizes.hasOwnProperty(n)) continue;
            try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { doc = null; }
            var hasEvents = doc && doc.events && doc.events.length, hasRows = doc && doc.rows && doc.rows.length;
            if (pass === 1 && hasEvents && !hasRows) continue;
            this.dropped++;
            if (pass === 1 && hasEvents) {
                doc.rows = [];
                doc.truncated = true;
                var body = JSON.stringify(doc), tmp = path.join(this.dir, '.' + n + '.tmp');
                try {
                    fs.writeFileSync(tmp, body, { mode: 420 });
                    fs.renameSync(tmp, file);
                    total += body.length - sizes[n];
                    sizes[n] = body.length;
                    continue;
                } catch (e) { try { fs.unlinkSync(tmp); } catch (ignored) { /* nothing to remove */ } }
            }
            try { fs.unlinkSync(file); } catch (e) { /* the agent may have removed it */ }
            total -= sizes[n];
            delete sizes[n];
            count--;
        }
    }
    return total;
};
PacketStore.prototype.status = function () {
    var self = this, names = this.files(), bytes = 0;
    names.forEach(function (n) { try { bytes += fs.statSync(path.join(self.dir, n)).size; } catch (e) { /* removed meanwhile */ } });
    var oldest = names.length ? Number(PACKET_NAME.exec(names[0])[1]) : null;
    return { pending: names.length, bytes: bytes, oldestAt: oldest ? new Date(oldest).toISOString() : null, dropped: this.dropped, writeErrors: this.writeErrors };
};

function holdFor(def) {
    if (def.intervalMs <= 2000) return 30000;
    if (def.intervalMs <= 10000) return 15 * 60000;
    return 30 * 60000;
}

/**
 * The recorder. ingest() takes raw SOME/IP structs, tick() runs once a second.
 * opts: { dataDir, now, log, catalog, config }
 */
function TelemetryRecorder(opts) {
    var self = this;
    this.now = opts.now || Date.now;
    this.log = opts.log || { warn: function () {}, info: function () {} };
    this.catalog = opts.catalog || CATALOG;
    this.dataDir = opts.dataDir;
    this.config = Object.assign({}, DEFAULTS, opts.config || {});
    this.configAt = 0;
    this.readConfig();
    this.store = new PacketStore(path.join(this.dataDir, DIR), this.config, this.now);
    this.byField = {};
    this.aggregators = {};
    this.enums = {};
    this.counters = { received: 0, invalid: 0, spikes: 0 };
    this.reasons = {};
    this.seen = {};
    this.catalog.signals.forEach(function (def) {
        var key = def.iface + '.' + def.field;
        (self.byField[key] = self.byField[key] || []).push(def);
        if (def.kind === 'numeric') self.aggregators[def.id] = new Aggregator(def, holdFor(def));
    });
    this.rows = [];
    this.lastFlush = this.now();
    this.lastSpeed = null;
    var saved = null;
    try { saved = JSON.parse(fs.readFileSync(path.join(this.dataDir, STATE_FILE), 'utf8')); } catch (e) { saved = null; }
    this.trips = new TripDetector(this.config, saved);
    if (this.config.enabled) this.trips.restore(this.now());
    else this.trips.saved = null;
    this.persist();
}
/** Interfaces and fields the recorder listens to: { iface: [field, ...] }. */
TelemetryRecorder.prototype.fields = function () {
    var out = {};
    this.catalog.signals.forEach(function (def) {
        var list = out[def.iface] = out[def.iface] || [];
        if (list.indexOf(def.field) === -1) list.push(def.field);
    });
    return out;
};
/** Settings from the Pi (written by the agent). Unknown or invalid values keep the defaults. */
TelemetryRecorder.prototype.readConfig = function () {
    var c;
    try { c = JSON.parse(fs.readFileSync(path.join(this.dataDir, CONFIG_FILE), 'utf8')); } catch (e) { return; }
    if (!c || typeof c !== 'object') return;
    if (typeof c.enabled === 'boolean') this.config.enabled = c.enabled;
    if (Number.isInteger(c.idleEndMin) && c.idleEndMin >= 2 && c.idleEndMin <= 120) this.config.idleEndMs = c.idleEndMin * 60000;
    if (Number.isInteger(c.bufferMb) && c.bufferMb >= 2 && c.bufferMb <= 200) this.config.bufferBytes = c.bufferMb * 1024 * 1024;
    this.configAt = this.now();
};
TelemetryRecorder.prototype.ingest = function (iface, field, raw) {
    if (!this.config.enabled) return;
    var defs = this.byField[iface + '.' + field] || [], t = this.now();
    for (var i = 0; i < defs.length; i++) this._sample(defs[i], decode(defs[i], raw), t);
};
TelemetryRecorder.prototype._sample = function (def, d, t) {
    this.counters.received++;
    if (!this.seen[def.id]) this.seen[def.id] = { first: new Date(t).toISOString(), valid: 0, invalid: 0 };
    if (def.kind === 'enum') {
        if (def.id === 'condition') this.trips.conditionSample(d, t);
        var key = d.valid ? d.value : 'invalid:' + (d.reason || '');
        if (this.enums[def.id] !== key) {
            this.enums[def.id] = key;
            // An enum change is a point sample: duration 0, the code as value.
            if (d.valid) this.rows.push([def.id, t, 0, d.value, d.value, d.value, d.value, 1]);
        }
        this._count(def, d);
        return;
    }
    if (!d.valid) {
        this._count(def, d);
        return;
    }
    if (def.id === 'speed') {
        var prev = this.lastSpeed;
        if (prev && t - prev.t < 5000) {
            var dt = Math.max(t - prev.t, 50) / 1000;
            if (Math.abs(d.value - prev.v) / 3.6 / dt > this.config.maxAccelMs2) {
                this.counters.spikes++;
                this.reasons.speed_spike = (this.reasons.speed_spike || 0) + 1;
                return;
            }
        }
        this.lastSpeed = { v: d.value, t: t };
        this.trips.speedSample(d.value, t);
    } else if (def.id === 'rpm') this.trips.rpmSample(d.value, t);
    else if (def.id === 'odometer') this.trips.odometerSample(d.value, t);
    this._count(def, d);
    this.aggregators[def.id].add(d.value, t, this.rows);
};
TelemetryRecorder.prototype._count = function (def, d) {
    var s = this.seen[def.id];
    if (d.valid) s.valid++;
    else { s.invalid++; this.counters.invalid++; this.reasons[d.reason] = (this.reasons[d.reason] || 0) + 1; }
};
/** Provider availability of one interface. Unavailable stops the held values at once. */
TelemetryRecorder.prototype.availability = function (iface, ok) {
    if (ok) return;
    var t = this.now(), self = this;
    this.catalog.signals.forEach(function (def) {
        if (def.iface === iface && self.aggregators[def.id]) self.aggregators[def.id].cut(t, self.rows);
        if (def.iface === iface && def.kind === 'enum') delete self.enums[def.id];
    });
    if (this.catalog.signals.some(function (def) { return def.iface === iface && def.id === 'condition'; })) this.trips.conditionSample({ valid: false }, t);
};
TelemetryRecorder.prototype.persist = function () {
    var file = path.join(this.dataDir, STATE_FILE), tmp = file + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(this.trips.saveState()), { mode: 420 }); fs.renameSync(tmp, file); }
    catch (e) { this.log.warn('telemetry state: ' + e.message); }
};
TelemetryRecorder.prototype.tick = function () {
    var t = this.now(), self = this;
    if (t - this.configAt > 30000) {
        var was = this.config.enabled;
        this.configAt = t;
        this.readConfig();
        if (was && !this.config.enabled) {
            this.trips.end(t, 'recording_disabled');
            Object.keys(this.aggregators).forEach(function (id) { self.aggregators[id].cut(t, self.rows); });
            this.enums = {};
            this.flush(true);
        }
    }
    if (!this.config.enabled) return;
    Object.keys(this.aggregators).forEach(function (id) { self.aggregators[id].roll(t, self.rows); });
    var tripBefore = this.trips.trip && this.trips.trip.id;
    this.trips.tick(t);
    var tripNow = this.trips.trip && this.trips.trip.id;
    if (tripBefore !== tripNow || this.trips.events.length) this.persist();
    else if (t % 30000 < 1000) this.persist();
    if (this.trips.events.length || this.rows.length >= this.config.maxPacketRows || t - this.lastFlush >= this.config.flushMs) this.flush();
};
/** Write the pending rows and trip events as one packet. force: also when nothing is due. */
TelemetryRecorder.prototype.flush = function (force) {
    var t = this.now();
    if (!force && !this.trips.events.length && !this.rows.length) { this.lastFlush = t; return null; }
    var rows = this.rows, events = this.trips.events;
    this.rows = [];
    this.trips.events = [];
    this.lastFlush = t;
    try {
        return this.store.write(rows, events, { trip: this.trips.trip ? this.trips.trip.id : null });
    } catch (e) {
        this.log.warn('telemetry packet: ' + e.message);
        // Keep the trip events for the next attempt; samples are dropped to stay bounded.
        this.trips.events = events.concat(this.trips.events);
        return null;
    }
};
TelemetryRecorder.prototype.status = function () {
    var trip = this.trips.trip, s = this.store.status();
    return {
        schema: 1, enabled: this.config.enabled, catalogVersion: this.catalog.version,
        trip: trip ? { id: trip.id, startAt: new Date(trip.startAt).toISOString(), lastActiveAt: new Date(trip.lastActiveAt).toISOString() } : null,
        condition: this.trips.condition ? this.trips.condition.name : null,
        buffer: s, counters: this.counters, reasons: this.reasons, signals: this.seen,
        idleEndMin: Math.round(this.config.idleEndMs / 60000), bufferMb: Math.round(this.config.bufferBytes / 1048576),
    };
};

module.exports = {
    TelemetryRecorder: TelemetryRecorder, TripDetector: TripDetector, Aggregator: Aggregator, PacketStore: PacketStore,
    decode: decode, CATALOG: CATALOG, DEFAULTS: DEFAULTS, DIR: DIR, CONFIG_FILE: CONFIG_FILE, STATE_FILE: STATE_FILE, PACKET_NAME: PACKET_NAME,
};
