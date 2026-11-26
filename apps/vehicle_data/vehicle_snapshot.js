'use strict';
/*
 * Vehicle Data: decoding of the read-only SOME/IP signals and the snapshot file
 * for the BMW AI companion agent (/var/opt/mgu-ai-agent reads it as root).
 *
 * Field names and types come from the unit's master catalog
 * (reference/someip-interfaces.json). Units are not documented there:
 *   - SecureMileage.mileage.currentMileage, MileageSupreme.mileageSupreme: UInt32, read as km
 *   - CBS remainingMileage*: UInt16, read as km; targetDate year: UInt8, read as 2000 + y
 * Every decoded value keeps its raw value next to it and is marked unverified until the
 * owner compares it with the iDrive service screen once.
 */
const fs = require('fs');
const path = require('path');

const FILE = 'bmw-vehicle-data.json';
const SCHEMA = 1;

// de.bmw.infotainmenttypes.InfotainmentTypes.IDScopeCBS
const CBS_SCOPES = {
    0: 'RESERVIERT', 1: 'OELSERVICE', 2: 'BREMSBELAEGE_V', 3: 'BREMSFLUESSIGKEIT', 4: 'MIKROFILTER',
    5: 'RESERVE', 6: 'BREMSBELAEGE_H', 7: 'DIESELPARTIKELFILTER', 9: 'GETRIEBEOEL', 10: 'ZUENDKERZEN_ADAPTIV',
    13: 'NOX_ADDITIV', 16: 'ZUENDKERZEN', 17: 'SICHTPRUEFUNGEN', 18: 'KUEHLFLUESSIGKEIT', 19: 'H2_CHECK',
    20: 'UEBERGABEDURCHSICHT', 21: 'EINFAHRKONTROLLE', 22: 'ADDITIV_FUER_DIESELPARTIKELFILTER', 23: 'WASSERFILTER',
    32: 'HU_HAUPTUNTERSUCHUNG', 33: 'AU_ABGASUNTERSUCHUNG', 35: 'GETRIEBEOEL_HAUPTGETRIEBE', 100: 'SICHTPRUEFUNG_ADAPTIV',
};
const CBS_LABELS = {
    OELSERVICE: 'Motoröl', BREMSBELAEGE_V: 'Bremsbeläge vorne', BREMSBELAEGE_H: 'Bremsbeläge hinten',
    BREMSFLUESSIGKEIT: 'Bremsflüssigkeit', MIKROFILTER: 'Mikrofilter', DIESELPARTIKELFILTER: 'Dieselpartikelfilter',
    GETRIEBEOEL: 'Getriebeöl', GETRIEBEOEL_HAUPTGETRIEBE: 'Getriebeöl', ZUENDKERZEN: 'Zündkerzen',
    ZUENDKERZEN_ADAPTIV: 'Zündkerzen', NOX_ADDITIV: 'AdBlue/NOx-Additiv', SICHTPRUEFUNGEN: 'Fahrzeug-Check',
    SICHTPRUEFUNG_ADAPTIV: 'Fahrzeug-Check', KUEHLFLUESSIGKEIT: 'Kühlflüssigkeit', H2_CHECK: 'H2-Check',
    UEBERGABEDURCHSICHT: 'Übergabedurchsicht', EINFAHRKONTROLLE: 'Einfahrkontrolle',
    ADDITIV_FUER_DIESELPARTIKELFILTER: 'DPF-Additiv', WASSERFILTER: 'Wasserfilter',
    HU_HAUPTUNTERSUCHUNG: 'Hauptuntersuchung', AU_ABGASUNTERSUCHUNG: 'Abgasuntersuchung',
};
// Legacy CBS fields (notifier only) and the member-name suffix each one uses.
const CBS_FIELDS = ['cBSMessageEngineOil', 'cBSMessageBrakeFront', 'cBSMessageBrakeRear', 'cBSMessageGearOil',
    'cBSMessageParticleFilter', 'cBSMessageSparkPlug'];
const QUALIFIER_OK = new Set([0, 'EVENT_DATA_AVAILABLE']);
const HISTORY_STATUS = { 1: 'SERVICE_PERFORMED', 2: 'SERVICE_CARRIED_OUT_LATE', 3: 'SERVICE_INCOMPLETE' };
const READ_STATUS = { 0: 'E_OK', 1: 'E_FILE_DOES_NOT_EXIST', 2: 'E_FILE_IS_EMPTY', 3: 'E_NO_READ_PERMISSION' };

const uint = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);
const enumName = (v, table) => (typeof v === 'string' ? v : Number.isInteger(v) ? (table[v] || String(v)) : null);

function scopeOf(v) {
    if (typeof v === 'string' && /^\d{1,5}$/.test(v)) v = Number(v);
    const name = enumName(v, CBS_SCOPES);
    const code = typeof v === 'number' ? v : Number(Object.keys(CBS_SCOPES).find((k) => CBS_SCOPES[k] === v));
    const known = Object.values(CBS_SCOPES).includes(name);
    return { code: Number.isInteger(code) ? code : null, name, label: CBS_LABELS[name] || (known ? name : null) };
}
function isoDate(y, m, d) {
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCMonth() === m - 1 ? t.toISOString().slice(0, 10) : null;
}

/** SecureMileage.mileage -> km or null. Values close to 2^32 are "no value". */
function decodeSecureMileage(v) {
    const km = v ? uint(v.currentMileage, 1999999) : null;
    return { km: km === 0 ? null : km, reason:typeof (v&&v.currentMileage)!=='number'?'unexpected_shape_or_type':
        !km?'invalid_value':null, manipulationState: v ? v.manipulationState : null, raw: v || null };
}
/** MileageSupreme.mileageSupreme -> km or null (only with the "available" qualifier). */
function decodeMileageSupreme(v) {
    const ok = v && QUALIFIER_OK.has(v.qualifierMileageSupreme);
    const km = ok ? uint(v.mileageSupreme, 1999999) : null;
    return { km: km === 0 ? null : km, reason:typeof (v&&v.mileageSupreme)!=='number'?'unexpected_shape_or_type':
        !ok?'qualifier_unavailable':!km?'invalid_value':null, qualifier: v ? v.qualifierMileageSupreme : null, raw: v || null };
}
/** One legacy CBS message. Member names end in the field's own suffix. */
function decodeCbs(field, v) {
    if (!v || typeof v !== 'object') return null;
    const sfx = field.replace(/^cBS/, 'CBS');
    const pick = (prefix) => v[prefix + sfx];
    const scope = scopeOf(pick('iDScope'));
    if (scope.name === null || scope.name === 'SIGNAL_UNBEFUELLT' || scope.code === 65535) return null;
    const remaining = uint(pick('remainingMileage'), 0xFFFE);
    const year = uint(pick('targetDateYear'), 0xFE), month = uint(pick('targetDateMonth'), 12), day = uint(pick('targetDateDay'), 31);
    return {
        field, scope: scope.name, scopeCode: scope.code, label: scope.label || ('Code ' + scope.name),
        remainingKm: remaining, dueDate: year === null ? null : isoDate(2000 + year, month, day),
        status: pick('statusScope'), counter: pick('counter'),
        availability: v['availibility' + sfx] !== undefined ? v['availibility' + sfx] : v['availability' + sfx],
        unverified: true, raw: v,
    };
}
/** ServiceHistory.readServiceHistory result -> list of services (newest first). */
function decodeServiceHistory(r) {
    if (!r || typeof r !== 'object') return { status: null, sets: [] };
    const status = enumName(r.statusOperation, READ_STATUS);
    if (status === 'E_OK' && !Array.isArray(r.dataSets)) return {status:null,sets:[]};
    const sets = (Array.isArray(r.dataSets) ? r.dataSets : []).slice(0, 60).map((s) => {
        const d = s && s.dateOfService || {};
        const entries = Array.isArray(s && s.serviceEntries) ? s.serviceEntries :
            Array.isArray(s && s.entries) ? s.entries : [];
        return {
            date: isoDate(d.yearOfService, d.monthOfService, d.dayOfService),
            km: uint(s && s.mileage, 0xFFFFFFF0),
            dealer: s && s.dealerInfo && typeof s.dealerInfo.dealerNumber === 'string' ? s.dealerInfo.dealerNumber.trim().slice(0, 40) : '',
            status: enumName(s && s.serviceStatus, HISTORY_STATUS),
            correction: s && s.correctionNumber,
            services: entries.slice(0, 30).map((e) => {
                const sc = scopeOf(e && e.serviceText);
                return { code: e && e.serviceText, scope: sc.name, label: sc.label || ('Code ' + (e && e.serviceText)),
                    status: enumName(e && e.serviceStatusPos, HISTORY_STATUS), remainingKm: uint(e && e.remainingDistance, 0xFFFFFFF0),
                    remainingTime: e && e.remainingTime };
            }),
        };
    }).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || (b.km || 0) - (a.km || 0));
    return { status, sets };
}

// x_call 4.25.3 reads VehicleInformation.Range.mileageKilometre directly in km.
function rangeMileage(v) {
    const km = uint(v && v.mileageKilometre, 1999999);
    return km > 0 ? km : null;
}

// The donor names the fields but does not interpret cBSServiceWay / cBSServiceDate.
// Preserve those raw scalars for diagnosis; use the explicit display calendar only.
function decodeCbsList(v) {
    if (!Array.isArray(v)) return null;
    const rows = [];
    for (const entry of v) {
        const item = entry && entry.cBSDataServiceWithSymbolID;
        const data = item && item.cBSDataService;
        if (!data || (typeof data.cBSIdentifier !== 'string' && !Number.isInteger(data.cBSIdentifier))) return null;
        const scope = scopeOf(data.cBSIdentifier);
        const year = uint(data.yearCBSDisplay, 9999), month = uint(data.monthCBSDisplay, 12), day = uint(item.dayCBSDisplay, 31);
        const monthDate = year >= 2000 && year <= 2100 && month >= 1 ? String(year)+'-'+('0'+month).slice(-2) : null;
        rows.push({scope:scope.name, label:typeof data.cBSServcieName === 'string' && data.cBSServcieName.trim() ?
            data.cBSServcieName.replace(/\0/g,'').trim().slice(0,100) : scope.label || 'CBS '+scope.name,
            status:typeof data.cBSColor === 'string' || Number.isInteger(data.cBSColor) ? data.cBSColor : null,
            dueDate:monthDate ? isoDate(year,month,day) : null, dueMonth:monthDate, remainingKm:null,
            source:'KombiInterface_2.cbsDataServiceList', available:typeof item.cBSAvail==='boolean'?item.cBSAvail:null});
    }
    return rows;
}

/** Collects decoded values and writes the snapshot atomically, only when something changed. */
class VehicleSnapshot {
    constructor(opts) {
        this.file = path.join(opts.dir, FILE);
        this.version = opts.version || '';
        this.now = opts.now || Date.now;
        this.onError = opts.onError || (() => {});
        this.state = { secure: null, supreme: null, cbs: {}, history: null, historyReadAt: null, signals: {} };
        this.samples = {};
        this.stages = {};
        this.received = {};
        this.last = '';
        this.lastWrite = 0;
        this.heartbeatAt = null;
    }
    available(name, ok, error) {
        const state = this.state.signals[name] || {};
        state.available = !!ok;
        if (error) { state.error = String(error).slice(0, 200); state.errorAt = new Date(this.now()).toISOString(); }
        this.state.signals[name] = state;
    }
    stage(name, key, value) {
        const row=this.stages[name] || {};
        if (key==='getter' && !row.initialGetter && value!=='pending') row.initialGetter=value;
        row[key]=value;
        this.stages[name]=row;
    }
    receivedValue(name, raw, count) {
        this.stage(name,'responseReceived',true);
        this.stage(name,'decoded',count!==null);
        const old = this.received[name] || {};
        const at = new Date(this.now()).toISOString();
        this.received[name] = {at, validAt:count === null ? old.validAt || null : at,
            count:count === null ? old.count || 0 : count, valid:count !== null};
        // Export structural evidence and tightly allowlisted numeric fields only.
        const shape = (v, depth) => {
            if (v === null || v === undefined) return null;
            if (Array.isArray(v)) return depth ? {length:v.length, sample:v.slice(0,2).map(x=>shape(x,depth-1))} : {length:v.length};
            if (typeof v !== 'object' || !depth) return typeof v;
            const fields = [];
            for (const key of Object.keys(v).slice(0,24)) {
                if (!/^[a-z_][a-z0-9_]{0,45}$/i.test(key) || /vin|token|secret|auth|password|key|dealer/i.test(key)) continue;
                const number = /^(currentMileage|mileageSupreme|mileageKilometre|ccmId|cCIdentifer|activeState|qualifierMileageSupreme|manipulationState|statusOperation|cBSServiceWay|cBSServiceDate|yearCBSDisplay|monthCBSDisplay|dayCBSDisplay|actualValuePressureTyreFLH|actualValuePressureTyreFRH|targetPressureTyre(FLH|FRH|RLH|RRH)|tpmsInternalLast(PositionId|PressureMbarId|TargetPressureMbarId|TemperatureDegCId)[1-4])$/i.test(key);
                const qualifier=key==='qualifierMileageSupreme'&&typeof v[key]==='string'&&/^EVENT_[A-Z_]{1,40}$/.test(v[key]);
                fields.push([key,qualifier||(number&&Number.isSafeInteger(v[key]))?v[key]:shape(v[key],depth-1)]);
            }
            return fields;
        };
        this.samples[name] = shape(raw,3);
    }
    range(v) {
        this.state.range = {km:rangeMileage(v),at:this.now()};
        this.rememberMileage(this.state.range,'VehicleInformation.Range');
        return this.state.range.km;
    }
    cbsList(v) {
        const rows = decodeCbsList(v);
        if (rows !== null) this.state.cbsList = rows.slice(0,50).map(row=>Object.assign(row,{at:this.now()}));
        return rows;
    }
    secureMileage(v) {
        this.state.secure = Object.assign(decodeSecureMileage(v),{at:this.now()});
        this.rememberMileage(this.state.secure,'SecureMileage');
    }
    mileageSupreme(v) {
        this.state.supreme = Object.assign(decodeMileageSupreme(v),{at:this.now()});
        this.rememberMileage(this.state.supreme,'MileageSupreme');
    }
    rememberMileage(sample,source) {
        if (sample.km!==null && (!this.lastMileage || sample.km>=this.lastMileage.km)) this.lastMileage={km:sample.km,source,at:sample.at,ecu:sample.ecu,did:sample.did,valid:false};
    }
    cbs(field, v) { const c = decodeCbs(field, v); if (c) this.state.cbs[field] = Object.assign(c, { at: this.now() }); else delete this.state.cbs[field]; }
    serviceHistory(r) { this.state.history = decodeServiceHistory(r); this.state.historyReadAt = this.now(); }
    diagnosticMileage(km,definition) {
        const reading={km,at:this.now(),source:definition.source,ecu:definition.ecu,did:definition.did};
        this.state.diagnosticMileage=reading;
        this.rememberMileage(reading,reading.source);
    }
    mileage(includeDiagnostic) {
        const sources = [
            ['SecureMileage', this.state.secure],
            ['MileageSupreme', this.state.supreme],
            ['VehicleInformation.Range', this.state.range],
        ];
        if (includeDiagnostic !== false && this.state.diagnosticMileage) {
            sources.push([this.state.diagnosticMileage.source,this.state.diagnosticMileage]);
        }
        const now = this.now();
        for (const [source, reading] of sources) {
            if (reading && reading.km !== null && now - reading.at <= 6 * 60000) {
                return {km:reading.km, source, at:reading.at, ecu:reading.ecu, did:reading.did};
            }
        }
        return includeDiagnostic === false ? null : this.lastMileage || null;
    }
    document() {
        const m = this.mileage(), iso = (t) => (t ? new Date(t).toISOString() : null);
        return Object.assign({
            schema: SCHEMA, app: 'vehicle_data', version: this.version,
            mileage: m ? { km: m.km, source: m.source, at: iso(m.at), ...(m.ecu===undefined?{}:{ecu:m.ecu,did:m.did}), valid:m.valid!==false, unverified: true } : null,
            mileageSources: {
                secure: this.state.secure && { km: this.state.secure.km, manipulationState: this.state.secure.manipulationState, at: iso(this.state.secure.at) },
                supreme: this.state.supreme && { km: this.state.supreme.km, qualifier: this.state.supreme.qualifier, at: iso(this.state.supreme.at) },
            },
            cbs: (this.state.cbsList ? this.state.cbsList.map(row=>{
                const legacy=Object.values(this.state.cbs).find(c=>c.scope===row.scope);
                return Object.assign({},row,{remainingKm:legacy?legacy.remainingKm:null,
                    remainingAt:legacy?iso(legacy.at):null,remainingSource:legacy?'ConditionBasedServicesLegacy':null,
                    dueDate:row.dueDate || (legacy && legacy.dueDate) || null});
            }) : Object.values(this.state.cbs)).map((c) => Object.assign({}, c, { at: iso(c.at) })),
            telemetry: {received:this.received,samples:this.samples,stages:this.stages},
            serviceHistory: this.state.history ? { status: this.state.history.status, readAt: iso(this.state.historyReadAt), sets: this.state.history.sets } : null,
            signals: this.state.signals,
        }, this.extra ? this.extra() : {});
    }
    /** Writes when the content changed, at most once per second. Returns true when written. */
    flush(force) {
        const doc = this.document(), t = this.now(), body = JSON.stringify(doc);
        const changed = body !== this.last;
        if (!force && (!changed || t - this.lastWrite < 1000)) return false;
        if (force) this.heartbeatAt = new Date(t).toISOString();
        if (this.heartbeatAt) doc.heartbeatAt = this.heartbeatAt;
        if (changed) this.writtenAt = new Date(t).toISOString();
        doc.writtenAt = this.writtenAt;
        try {
            const dir = path.dirname(this.file);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir);
            fs.writeFileSync(this.file + '.tmp', JSON.stringify(doc, null, 1));
            fs.renameSync(this.file + '.tmp', this.file);
            this.last = body; this.lastWrite = t;
            return true;
        } catch (e) { this.onError(e); return false; }
    }
}

module.exports = { VehicleSnapshot, decodeSecureMileage, decodeMileageSupreme, decodeCbs, decodeServiceHistory,
    CBS_FIELDS, CBS_LABELS, FILE, rangeMileage, decodeCbsList };
