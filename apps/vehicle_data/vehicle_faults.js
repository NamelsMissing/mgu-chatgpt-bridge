'use strict';
/*
 * Vehicle Data: check-control messages, tyre pressures, fault memory and DPF values.
 *
 * Sources (field names/types from the unit's master catalog, all read-only):
 *   - de.bmw.infotainment.checkcontrol.CheckControlMaster.basicList: BasicCCMInfo array or individual event
 *     {ccmId, reason, requestorDiagAddr, timeStamp_s, activeState AKTIV/INAKTIV}
 *   - de.bmw.infotainment.KombiInterface_2: newCCMessage / requestCCMessage(id) -> the text in
 *     the car's own language (cCName, additionalDescription)
 *   - de.bmw.infotainment.vehicle.TPMSInternalData.tpmsInternalLastValues: per wheel pressure
 *     and target pressure in mbar, temperature in degC (as the field names say)
 *   - UDS 0x19 02 0C (ReadDTCInformation by status mask) to all ECUs over the head unit's own
 *     diagnostic transport, and UDS 0x22 for the DPF values of the engine ECU (0x12).
 *     Only these two read services are ever sent (see ReadOnlyDiag in main.js).
 */
const { parseDtcReply, statusInfo, hex } = require('./kit/diag');

const ACTIVE = new Set([0, 'AKTIV', '0']);
const INACTIVE = new Set([1, 'INAKTIV', '1']);
const CC_REASON = { 0: 'DTC_MESSAGE', 1: 'DTC_MAX_AMOUNT_REACHED', 2: 'CCM_REQUESTED_BY_ECU', 3: 'CCM_SHOWN_BY_IC', 255: 'CC_MESSAGE' };
const POSITIONS = { 0: 'FRONT_LEFT', 1: 'FRONT_RIGHT', 2: 'REAR_LEFT', 3: 'REAR_RIGHT', 4: 'SPARE_TYRE' };
const BATTERY = { 0: '0%', 1: 'NOT_OK', 2: '20%', 3: '30%', 4: '40%', 5: '50%', 6: '60%', 7: '70%', 8: '80%', 9: '90%', 10: '100%', 11: 'OK' };
const uint = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);
const enumName = (v, table) => (typeof v === 'string' ? v : Number.isInteger(v) ? (table[v] || String(v)) : null);
const text = (v, max) => (typeof v === 'string' ? v.replace(/\u0000+$/, '').trim().slice(0, max) : '');

const BASIC = 'CheckControlMaster.basicList';
const LIST = 'KombiInterface_2.ccList';
const RISK_LIST = 'KombiInterface_2.ccListRiskClass';
const REQUEST = 'KombiInterface_2.requestCCMessage';
const NEW_MESSAGE = 'KombiInterface_2.newCCMessage';
const COLORS = ['DEFAULT', 'RED', 'YELLOW', 'GREEN', 'ORANGE', 'WHITE'];
const RISKS = ['DEFAULT', ...Array.from({length:18}, (_, i) => 'RK' + (i+1)*10), 'RK800', 'RK900'];
RISKS[255] = 'UNKNOWN';
const enumValue = (v, entries) => {
    if (typeof v === 'string' && entries.includes(v)) return v;
    return Number.isInteger(v) ? entries[v] || null : null;
};

function decodeBasic(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return 'invalid_struct';
    const id = uint(v.ccmId, 0xFFFE);
    if (!id) return 'invalid_id';
    const active = ACTIVE.has(v.activeState) ? true : INACTIVE.has(v.activeState) ? false : null;
    if (active === null) return 'invalid_active_state';
    return { id, active, reason: enumName(v.reason, CC_REASON), ecu: uint(v.requestorDiagAddr, 0xFF),
        carTime: uint(v.timeStamp_s, 0xFFFFFFFE), carTimeMs: uint(v.timeStamp_ms, 0xFF) };
}
function decodeCcEvent(v) {
    const decoded = decodeBasic(v);
    return typeof decoded === 'string' ? null : decoded;
}
function decodeKombi(v, risk) {
    const element = v && v[risk ? 'cCListRiskClassElement' : 'cCListElement'];
    if (!element || typeof element !== 'object') return 'unsupported_union';
    const id = uint(element.cCIdentifer, 0xFFFE);
    if (!id) return 'invalid_id';
    return { id, active:true, shortText:text(element.cCShortName,300), color:enumValue(element.cCColor,COLORS),
        symbolId:uint(element.cCListSymbolID,0xFFFF), indentation:enumValue(element.cCIndentation,['INDENT_LEVEL_0','INDENT_LEVEL_1']),
        resourceId:uint(element.ricResourceID,0xFFFFFFFF), riskClass:risk ? enumValue(element.cCRiskClass,RISKS) : null };
}
function decodeCcBatch(value, source, origin) {
    const basic = source === BASIC;
    const array = Array.isArray(value);
    const result = { origin, shape:array?'array':value===null?'null':typeof value, length:array?value.length:null,
        valid:0, rejected:0, reasons:{}, complete:false, rows:[] };
    const reject = reason => {
        result.rejected++;
        result.reasons[reason] = (result.reasons[reason] || 0) + 1;
    };
    if (array && value.length > (basic ? 45 : 42)) {
        reject('array_too_long');
        return result;
    }
    if (!array && (!basic || !value || typeof value !== 'object')) {
        reject('expected_array_or_struct');
        return result;
    }
    const entries = array ? value : [value];
    const states = new Map(), counts = new Map(), conflicted = new Set();
    for (const entry of entries) {
        const row = basic ? decodeBasic(entry) : decodeKombi(entry,source===RISK_LIST);
        if (typeof row === 'string') { reject(row); continue; }
        if (conflicted.has(row.id)) {
            reject('conflicting_duplicate');
        } else if (states.has(row.id) && states.get(row.id).active !== row.active) {
            for (let n=0;n<counts.get(row.id)+1;n++) reject('conflicting_duplicate');
            states.delete(row.id);
            conflicted.add(row.id);
        } else {
            states.set(row.id,row);
            counts.set(row.id,(counts.get(row.id)||0)+1);
        }
    }
    result.rows = Array.from(states.values());
    result.valid = entries.length - result.rejected;
    result.complete = origin === 'get' && array && !result.rejected;
    return result;
}
/** The generated SDK supplies decoded JavaScript strings for Utf16D. */
function decodeCcText(u) {
    if (!u || typeof u !== 'object') return null;
    const envelope = u.requestedCCMessage || u;
    const withSymbol = envelope.cCMessageWithSymbol;
    const m = envelope.cCMessageStruct || (withSymbol && withSymbol.cCMessage) || envelope;
    const id = m && uint(m.cCIdentifier, 0xFFFE);
    if (!id) return null;
    const name = text(m.cCName, 300), description = text(m.additionalDescription,1500);
    return { id, text:name, description, color:enumValue(m.cCColor,COLORS), symbolId:uint(m.cCSymbolID,0xFFFF),
        type:enumValue(m.cCType,['TYP_A','TYP_B','TYP_C','TYP_D','TYP_E']) };
}

/** tpmsInternalLastValues -> wheels with pressure in bar (from mbar) and temperature. */
function decodeTyres(v) {
    if (!v || typeof v !== 'object') return [];
    const out = [];
    for (let i = 1; i <= 4; i++) {
        const pos = enumName(v['tpmsInternalLastPositionId' + i], POSITIONS);
        if (!pos || !/^(FRONT|REAR)_(LEFT|RIGHT)$|^SPARE_TYRE$/.test(pos)) continue;
        const p = uint(v['tpmsInternalLastPressureMbarId' + i], 10000), target = uint(v['tpmsInternalLastTargetPressureMbarId' + i], 10000);
        const temp = v['tpmsInternalLastTemperatureDegCId' + i];
        const t = Number.isInteger(temp) && temp >= -48 && temp <= 0xFD ? temp : null;
        out.push({ position: pos, pressureBar: p ? p / 1000 : null,
            targetBar: target ? target / 1000 : null, temperatureC: t,
            battery: enumName(v['tpmsInternalLastBatteryStatusId' + i], BATTERY), rawPressure: v['tpmsInternalLastPressureMbarId' + i],
            rawTemperature: v['tpmsInternalLastTemperatureDegCId' + i] });
    }
    return out;
}

/** Replies of a functional 0x19 02 0C read -> per-ECU result and DTC list. */
function decodeDtcScan(replies, params) {
    const ecus = [], dtcs = [];
    replies.forEach((uds, ecu) => {
        const r = parseDtcReply(uds, params);
        ecus.push({ ecu, address: '0x' + hex(ecu), ok: r.ok, nrc: r.nrc === null ? null : '0x' + hex(r.nrc), count: r.dtcs.length });
        for (const d of r.dtcs.slice(0, 80)) {
            const s = statusInfo(d.status);
            dtcs.push({ ecu, address: '0x' + hex(ecu), code: d.code, status: d.status, statusHex: '0x' + hex(d.status),
                label: s.label, severity: s.sev, active: (d.status & 0x01) === 1, confirmed: (d.status & 0x08) === 8 });
        }
    });
    ecus.sort((a, b) => a.ecu - b.ecu);
    dtcs.sort((a, b) => a.ecu - b.ecu || a.code.localeCompare(b.code));
    return { ecus, dtcs };
}

/** Accumulates check-control state, tyres, fault memory and DPF values for the snapshot. */
class FaultState {
    constructor(now) {
        this.now = now || Date.now;
        this.cc = new Map();      // id -> {id, active, ecu, reason, since, lastSeen}
        this.ccTexts = new Map(); // id -> original texts and metadata, by field source
        this.ccReceipts = {};
        this.ccEvents = [];       // newest last, max 100
        this.tyres = null; this.rdcTyres = null;
        this.dtc = null;
        this.dpf = {}; this.dpfAt = null;
    }
    ccBatch(v, source, origin) {
        const result = decodeCcBatch(v,source,origin);
        const now = this.now();
        // Prefer a recent cluster list when both getters are present; basicList events still apply.
        const priority = [BASIC, LIST, RISK_LIST];
        const lowerPriority = priority.indexOf(source) < priority.indexOf(this.ccListSource) && now - this.ccListAt < 150000;
        const authoritative = result.complete && !lowerPriority;
        if (authoritative) {
            const included = new Set(result.rows.filter(row=>row.active).map(row=>row.id));
            const reported = new Set(result.rows.map(row=>row.id));
            for (const entry of this.cc.values()) {
                if (entry.active && !included.has(entry.id) && !reported.has(entry.id)) {
                    this.updateCc({id:entry.id,active:false,source});
                }
            }
            this.ccListAt = now;
            this.ccListSource = source;
        }
        for (const row of result.rows) {
            if (source !== BASIC) this.rememberCcText(row,source);
            if (!lowerPriority || origin !== 'get') this.updateCc(Object.assign({},row,{source}));
        }
        const messages = result.rows.map(row=>({id:row.id,active:row.active,text:row.shortText,color:row.color}));
        const receipt = Object.assign({},result,{at:new Date(now).toISOString(),authoritative,messages});
        delete receipt.rows;
        this.ccReceipts[source] = receipt;
        if (origin === 'get') this.ccReceipts[source+':getter'] = receipt;
        return result;
    }
    updateCc(e) {
        const t = this.now(), prev = this.cc.get(e.id);
        const changed = !prev || prev.active !== e.active;
        const row = Object.assign({},prev);
        for (const key of ['id','active','ecu','reason','carTime','carTimeMs','source']) {
            if (e[key] != null) row[key] = e[key];
        }
        row.since = changed ? t : prev.since;
        row.lastSeen = t;
        if (changed) {
            this.ccEvents.push(Object.assign({},row,{at:t}));
            if (this.ccEvents.length > 100) this.ccEvents.shift();
        }
        this.cc.set(e.id,row);
        return row;
    }
    rememberCcText(value, source) {
        const stored = this.ccTexts.get(value.id) || {};
        const row = Object.assign({},stored[source]);
        for (const key of ['text','shortText','description','color','type','symbolId','riskClass','indentation','resourceId']) {
            if (value[key] != null && value[key] !== '') row[key] = value[key];
        }
        stored[source] = row;
        this.ccTexts.set(value.id,stored);
    }
    ccText(u, source, expected) {
        const m = decodeCcText(u);
        const reason = !m ? 'unrecognized_text' : expected != null && m.id !== expected ? 'mismatched_id' : null;
        this.ccReceipts[source] = { at:new Date(this.now()).toISOString(), origin:expected==null?'event':'method',
            shape:u===null?'null':Array.isArray(u)?'array':typeof u, length:null, valid:reason?0:1, rejected:reason?1:0,
            reasons:reason?{[reason]:1}:{}, complete:false, authoritative:false,messages:reason?[]:[m] };
        if (reason) return null;
        this.rememberCcText(m,source);
        return m;
    }
    needsText(id) { const entries = this.ccTexts.get(id); return !entries || !(entries[REQUEST] && entries[REQUEST].description); }
    ccWithText(c) {
        const details = this.ccTexts.get(c.id) || {};
        const sources = [RISK_LIST,LIST,REQUEST,NEW_MESSAGE];
        const row = Object.assign({},c);
        for (const key of ['shortText','text','description','color','type','symbolId','riskClass','indentation','resourceId']) {
            const source = sources.find(name=>details[name] && details[name][key] != null);
            if (source) {
                row[key] = details[source][key];
                if (key === 'text') row.textSource = source;
                if (key === 'shortText') row.shortTextSource = source;
            }
        }
        if (row.shortText) {
            row.text = row.shortText;
            row.textSource = row.shortTextSource;
        }
        return row;
    }
    setTyres(v) {
        const wheels = decodeTyres(v);
        if (wheels.some(row=>row.pressureBar!==null||row.targetBar!==null||row.temperatureC!==null)) this.tyres = {wheels, at:this.now(), source:'TPMSInternalData'};
        return wheels;
    }
    setRdcTyres(wheels) {
        if (wheels.length) this.rdcTyres = {wheels, at:this.now(), source:'RDC 0x29'};
    }
    tyreReading() {
        const [primary, fallback] = [this.tyres,this.rdcTyres];
        const quality = sample => sample ? sample.wheels.reduce((score, wheel) =>
            score + Number(wheel.pressureBar!==null)*2 + Number(wheel.temperatureC!==null), 0) : 0;
        const fresh = sample => sample && this.now()-sample.at <= 150000;
        if (fresh(primary) && (!fresh(fallback) || quality(primary) >= quality(fallback))) return primary;
        if (fresh(fallback)) return fallback;
        return [primary,fallback].filter(Boolean).sort((a,b)=>b.at-a.at)[0] || null;
    }
    setDtc(requestId, replies, params, error) {
        const r = replies ? decodeDtcScan(replies, params) : { ecus: [], dtcs: [] };
        this.dtc = { requestId: requestId || null, readAt: this.now(), error: error ? String(error).slice(0, 200) : null, ecus: r.ecus, dtcs: r.dtcs };
        return this.dtc;
    }
    setDpf(name, value) { if (Number.isFinite(value)) { this.dpf[name] = Math.round(value * 1000) / 1000; this.dpfAt = this.now(); this.dpfTimes = this.dpfTimes || {}; this.dpfTimes[name] = new Date(this.dpfAt).toISOString(); } }
    document() {
        const iso = (t) => (t ? new Date(t).toISOString() : null);
        const tyreReading = this.tyreReading();
        const withText = c => this.ccWithText(c);
        return {
            checkControl: {
                listAt:iso(this.ccListAt), source:this.ccListSource || BASIC, receipts:this.ccReceipts,
                active: Array.from(this.cc.values()).filter((c) => c.active).map((c) => Object.assign(withText(c), { since: iso(c.since), lastSeen: iso(c.lastSeen) })),
                events: this.ccEvents.slice(-50).map((e) => Object.assign(withText(e), { at: iso(e.at) })),
            },
            tyres: tyreReading ? Object.assign({},tyreReading,{at:iso(tyreReading.at),unverified:true}) : null,
            faultMemory: this.dtc ? Object.assign({}, this.dtc, { readAt: iso(this.dtc.readAt) }) : null,
            dpf: this.dpfAt ? Object.assign({ at: iso(this.dpfAt), fieldTimes: this.dpfTimes }, this.dpf) : null,
        };
    }
}

module.exports = { FaultState, decodeCcEvent, decodeCcBatch, decodeCcText, decodeTyres, decodeDtcScan };
