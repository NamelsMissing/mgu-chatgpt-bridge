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
    const km = v ? uint(v.currentMileage, 0xFFFFFFF0) : null;
    return { km: km === 0 ? null : km, manipulationState: v ? v.manipulationState : null, raw: v || null };
}
/** MileageSupreme.mileageSupreme -> km or null (only with the "available" qualifier). */
function decodeMileageSupreme(v) {
    const ok = v && QUALIFIER_OK.has(v.qualifierMileageSupreme);
    const km = ok ? uint(v.mileageSupreme, 0xFFFFFFF0) : null;
    return { km: km === 0 ? null : km, qualifier: v ? v.qualifierMileageSupreme : null, raw: v || null };
}
/** One legacy CBS message. Member names end in the field's own suffix. */
function decodeCbs(field, v) {
    if (!v || typeof v !== 'object') return null;
    const sfx = field.replace(/^cBS/, 'CBS');
    const pick = (prefix) => v[prefix + sfx];
    const scope = scopeOf(pick('iDScope'));
    if (scope.name === 'SIGNAL_UNBEFUELLT' || scope.code === 65535) return null;
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

/** Collects decoded values and writes the snapshot atomically, only when something changed. */
class VehicleSnapshot {
    constructor(opts) {
        this.file = path.join(opts.dir, FILE);
        this.version = opts.version || '';
        this.now = opts.now || Date.now;
        this.state = { secure: null, supreme: null, cbs: {}, history: null, historyReadAt: null, signals: {} };
        this.last = '';
        this.lastWrite = 0;
    }
    available(name, ok, error) { this.state.signals[name] = { available: !!ok, error: error ? String(error).slice(0, 200) : null }; }
    secureMileage(v) { this.state.secure = Object.assign(decodeSecureMileage(v), { at: this.now() }); }
    mileageSupreme(v) { this.state.supreme = Object.assign(decodeMileageSupreme(v), { at: this.now() }); }
    cbs(field, v) { const c = decodeCbs(field, v); if (c) this.state.cbs[field] = Object.assign(c, { at: this.now() }); else delete this.state.cbs[field]; }
    serviceHistory(r) { this.state.history = decodeServiceHistory(r); this.state.historyReadAt = this.now(); }
    mileage() {
        const s = this.state.secure, p = this.state.supreme;
        if (s && s.km !== null) return { km: s.km, source: 'SecureMileage', at: s.at };
        if (p && p.km !== null) return { km: p.km, source: 'MileageSupreme', at: p.at };
        return null;
    }
    document() {
        const m = this.mileage(), iso = (t) => (t ? new Date(t).toISOString() : null);
        return Object.assign({
            schema: SCHEMA, app: 'vehicle_data', version: this.version,
            mileage: m ? { km: m.km, source: m.source, at: iso(m.at), unverified: true } : null,
            mileageSources: {
                secure: this.state.secure && { km: this.state.secure.km, manipulationState: this.state.secure.manipulationState, at: iso(this.state.secure.at) },
                supreme: this.state.supreme && { km: this.state.supreme.km, qualifier: this.state.supreme.qualifier, at: iso(this.state.supreme.at) },
            },
            cbs: Object.values(this.state.cbs).map((c) => Object.assign({}, c, { at: iso(c.at) })),
            serviceHistory: this.state.history ? { status: this.state.history.status, readAt: iso(this.state.historyReadAt), sets: this.state.history.sets } : null,
            signals: this.state.signals,
        }, this.extra ? this.extra() : {});
    }
    /** Writes when the content changed, at most once per second. Returns true when written. */
    flush(force) {
        const doc = this.document(), body = JSON.stringify(doc), t = this.now();
        if (body === this.last || (!force && t - this.lastWrite < 1000)) return false;
        doc.writtenAt = new Date(t).toISOString();
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(this.file + '.tmp', JSON.stringify(doc, null, 1));
            fs.renameSync(this.file + '.tmp', this.file);
            this.last = body; this.lastWrite = t;
            return true;
        } catch (e) { return false; }
    }
}

module.exports = { VehicleSnapshot, decodeSecureMileage, decodeMileageSupreme, decodeCbs, decodeServiceHistory,
    CBS_FIELDS, CBS_LABELS, FILE };
