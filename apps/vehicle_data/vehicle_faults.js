'use strict';
/*
 * Vehicle Data: check-control messages, tyre pressures, fault memory and DPF values.
 *
 * Sources (field names/types from the unit's master catalog, all read-only):
 *   - de.bmw.infotainment.checkcontrol.CheckControlMaster.basicList: one check-control event
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

const ACTIVE = new Set([0, 'AKTIV']);
const INACTIVE = new Set([1, 'INAKTIV']);
const CC_REASON = { 0: 'DTC_MESSAGE', 1: 'DTC_MAX_AMOUNT_REACHED', 2: 'CCM_REQUESTED_BY_ECU', 3: 'CCM_SHOWN_BY_IC', 255: 'CC_MESSAGE' };
const POSITIONS = { 0: 'FRONT_LEFT', 1: 'FRONT_RIGHT', 2: 'REAR_LEFT', 3: 'REAR_RIGHT', 4: 'SPARE_TYRE' };
const BATTERY = { 0: '0%', 1: 'NOT_OK', 2: '20%', 3: '30%', 4: '40%', 5: '50%', 6: '60%', 7: '70%', 8: '80%', 9: '90%', 10: '100%', 11: 'OK' };
const uint = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);
const enumName = (v, table) => (typeof v === 'string' ? v : Number.isInteger(v) ? (table[v] || String(v)) : null);
const text = (v, max) => (typeof v === 'string' ? v.replace(/\u0000+$/, '').trim().slice(0, max) : '');

/** One CheckControlMaster.basicList event. */
function decodeCcEvent(v) {
    if (!v || typeof v !== 'object') return null;
    const id = uint(v.ccmId, 0xFFFE);
    if (id === null || id === 0) return null;
    const active = ACTIVE.has(v.activeState) ? true : INACTIVE.has(v.activeState) ? false : null;
    if (active === null) return null;
    return { id, active, reason: enumName(v.reason, CC_REASON), ecu: uint(v.requestorDiagAddr, 0xFF),
        carTime: uint(v.timeStamp_s, 0xFFFFFFFE) };
}
// KombiInterface_2.ccList, as consumed by BMW x_call. A valid empty list is authoritative.
function decodeCcList(v) {
    if (!Array.isArray(v) || v.length>120) return null;
    const ids = new Set();
    for (const entry of v) {
        const element = entry && entry.cCListElement;
        const id = uint(element && element.cCIdentifer,0xFFFE);
        if (!id) return null;
        ids.add(id);
    }
    return Array.from(ids);
}
/** CCMessageUnion (newCCMessage / requestCCMessage) -> {id, text, description}. */
function decodeCcText(u) {
    if (!u || typeof u !== 'object') return null;
    let m = u.cCMessageStruct || (u.cCMessageWithSymbol && u.cCMessageWithSymbol.cCMessage) || u.requestedCCMessage || u;
    if (m && !m.cCIdentifier && m.cCMessageStruct) m = m.cCMessageStruct;
    if (m && !m.cCIdentifier && m.cCMessageWithSymbol) m = m.cCMessageWithSymbol.cCMessage;
    const id = m && uint(m.cCIdentifier, 0xFFFE);
    const name = m && text(m.cCName, 300);
    if (!id || !name) return null;
    return { id, text: name, description: text(m.additionalDescription, 1500) };
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
        this.ccTexts = new Map(); // id -> {text, description}
        this.ccEvents = [];       // newest last, max 100
        this.tyres = null; this.rdcTyres = null;
        this.dtc = null;
        this.dpf = {}; this.dpfAt = null;
    }
    ccEvent(v) {
        const e = decodeCcEvent(v);
        if (!e) return null;
        return this.updateCc(e);
    }
    ccList(v) {
        const ids = decodeCcList(v);
        if (!ids) return null;
        const included = new Set(ids);
        for (const e of this.cc.values()) {
            if (e.active && !included.has(e.id)) this.updateCc(Object.assign({},e,{active:false}));
        }
        for (const id of ids) this.updateCc({id,active:true,ecu:null});
        this.ccListAt = this.now();
        return ids;
    }
    updateCc(e) {
        const t = this.now(), prev = this.cc.get(e.id);
        if (prev && e.ecu == null) e.ecu = prev.ecu;

        if (!prev || prev.active !== e.active) {
            this.ccEvents.push({ id: e.id, active: e.active, ecu: e.ecu, reason: e.reason, at: t });
            if (this.ccEvents.length > 100) this.ccEvents.splice(0, this.ccEvents.length - 100);
        }
        this.cc.set(e.id, { id: e.id, active: e.active, ecu: e.ecu, reason: e.reason, since: prev && prev.active === e.active ? prev.since : t, lastSeen: t });
        return e;
    }
    ccText(u) { const m = decodeCcText(u); if (m) this.ccTexts.set(m.id, { text: m.text, description: m.description }); return m; }
    needsText(id) { return !this.ccTexts.has(id); }
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
        const withText = (c) => Object.assign({}, c, this.ccTexts.get(c.id) || { text: null, description: '' });
        return {
            checkControl: {
                listAt:iso(this.ccListAt), source:this.ccListAt?'KombiInterface_2.ccList':'CheckControlMaster.basicList',
                active: Array.from(this.cc.values()).filter((c) => c.active).map((c) => Object.assign(withText(c), { since: iso(c.since), lastSeen: iso(c.lastSeen) })),
                events: this.ccEvents.slice(-50).map((e) => Object.assign(withText(e), { at: iso(e.at) })),
            },
            tyres: tyreReading ? Object.assign({},tyreReading,{at:iso(tyreReading.at),unverified:true}) : null,
            faultMemory: this.dtc ? Object.assign({}, this.dtc, { readAt: iso(this.dtc.readAt) }) : null,
            dpf: this.dpfAt ? Object.assign({ at: iso(this.dpfAt), fieldTimes: this.dpfTimes }, this.dpf) : null,
        };
    }
}

module.exports = { FaultState, decodeCcEvent, decodeCcList, decodeCcText, decodeTyres, decodeDtcScan };
