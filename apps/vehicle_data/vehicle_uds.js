'use strict';

// ReadDataByIdentifier definitions and positive 2021 BMW 3 Series captures:
// https://github.com/OBDb/BMW-3-Series/tree/414dd76abbbb592dcd64b486f7d045b9fa4d43e2/tests/test_cases/2021
const { replyTo } = require('./kit/diag');
const ODOMETERS = [
    {ecu:0x60,did:0xD122,length:4,source:'KOMBI 0xD122'},
    {ecu:0x60,did:0xD10D,length:8,source:'KOMBI 0xD10D RAM'},
    {ecu:0x40,did:0x1700,length:4,source:'BDC 0x1700'},
    {ecu:0x12,did:0x558E,length:4,source:'DDE 0x558E'},
];
const MILEAGE_HISTORY = [{ecu:0x12,did:0x40A3,length:14},{ecu:0x40,did:0x4824,length:14}];
const RDC = [
    { ecu: 0x29, did: 0xDC98, length: 24, position: 'FRONT_LEFT' },
    { ecu: 0x29, did: 0xDC99, length: 24, position: 'FRONT_RIGHT' },
    { ecu: 0x29, did: 0xDC9A, length: 24, position: 'REAR_LEFT' },
    { ecu: 0x29, did: 0xDC9B, length: 24, position: 'REAR_RIGHT' },
];

async function read(diag, definition, decode) {
    const data = [definition.did >> 8, definition.did & 0xFF];
    const accept = replyTo(0x22, data);
    const reply = await diag.physical(definition.ecu, 0x22, data, 3000, accept,
        { maxRetries: 1, callTimeoutMs: 3500, hardTimeoutMs: 12000 });
    if (!reply) return { reason: 'no_reply' };
    if (!accept(reply)) return { reason: 'unexpected_reply' };
    if (reply[0] === 0x7F) return { reason: 'nrc_' + reply[2].toString(16).toUpperCase() };
    if (reply.length !== 3 + definition.length) return { reason: 'unexpected_reply_length' };
    const value = decode(Buffer.from(reply.slice(3)), definition);
    return value === null ? { reason: 'invalid_value' } : { value };
}

const validKm = n => n > 0 && n < 2000000 ? n : null;
const hexDid = did => did.toString(16).toUpperCase();
async function readMileage(diag, definition) {
    const {ecu,did,length}=definition;
    const data=[did >> 8,did & 0xFF], accept=replyTo(0x22,data);
    const detail={ecu,did,request:[0x22].concat(data),expectedLength:length,actualLength:null,rule:'UInt32BE × 1 km'};
    let reply;
    try {
        reply=await diag.physical(ecu,0x22,data,2200,accept,{maxRetries:0,callTimeoutMs:3200,hardTimeoutMs:8000});
    } catch (e) { return {reason:'transport_or_queue',detail}; }
    if (!reply) return {reason:'no_reply',detail};
    detail.responseLength=reply.length;
    if (!accept(reply)) return {reason:'unexpected_reply',detail};
    if (reply[0]===0x7F) {
        detail.nrc=reply[2];
        return {reason:'nrc_'+hexDid(reply[2]).padStart(2,'0'),detail};
    }
    detail.actualLength=reply.length-3;
    if (detail.actualLength!==length) return {reason:'unexpected_reply_length',detail};
    const payload=Buffer.from(reply.slice(3));
    detail.payload=payload.toString('hex').toUpperCase();
    if (length===14) {
        detail.rule='FEPM: UInt32BE + 5 × UInt16BE (gekürzt)';
        detail.historyCurrent=payload.readUInt32BE(0);
        detail.historyPrevious=[4,6,8,10,12].map(offset=>payload.readUInt16BE(offset));
        return {historical:true,detail};
    }
    const raw=payload.readUInt32BE(0);
    // BDC defines an additional 24-bit validity limit inside the four-byte field.
    const value=did===0x1700&&raw>=0xFFFFFF?null:validKm(raw);
    detail.km=value;
    if (did===0xD10D) {
        detail.rule='UInt32BE RAM + UInt32BE EEPROM × 1 km';
        detail.eepromKm=validKm(payload.readUInt32BE(4));
        if (value!==null&&detail.eepromKm!==null&&Math.abs(value-detail.eepromKm)>50)detail.warning='ram_eeprom_difference';
    }
    return value===null?{reason:'invalid_value',detail}:{value,detail};
}

class MileageSources {
    constructor(clock) { this.clock=clock||Date.now; this.reset(); }
    reset() { this.states={}; this.preferred=null; }
    candidates() {
        const eligible=ODOMETERS.filter(def=>!this.states[def.did]||this.states[def.did].retryAt<=this.clock());
        const index=eligible.findIndex(def=>def.did===this.preferred);
        if (index>0) eligible.unshift(eligible.splice(index,1)[0]);
        return eligible;
    }
    record(def,result) {
        const previous=this.states[def.did]||{},at=this.clock();
        const ok=result.value!==undefined,failures=ok?0:(previous.failures||0)+1;
        const delay=ok?0:/^nrc_(11|31|7E|7F)$/.test(result.reason)?30*60000:
            Math.min(10*60000,60000*Math.pow(2,Math.min(failures-1,4)));
        if (ok) this.preferred=def.did;
        else if (this.preferred===def.did) this.preferred=null;
        const state={failures,retryAt:at+delay,lastSuccess:ok?at:previous.lastSuccess||null,available:ok};
        this.states[def.did]=state;
        return state;
    }
}

function readWheel(diag, wheel) {
    return read(diag, wheel, (data, definition) => {
        // Skip the sensor identifier. The DID selects the corner; the following
        // byte is not used as a wheel index (observed packed values exceed 3).
        const pressure = data.readUInt16BE(5);
        if (pressure === 0 || pressure > 6300) return null;
        const target = data.readUInt16BE(8), fahrenheit = data[7];
        return {
            position: definition.position,
            pressureBar: pressure / 1000,
            targetBar: target > 0 && target <= 6300 ? target / 1000 : null,
            temperatureC: fahrenheit === 0xFF ? null : Math.round((fahrenheit - 32) * 5 / 9),
        };
    });
}

module.exports = { RDC, ODOMETERS, MILEAGE_HISTORY, MileageSources, readMileage, readWheel };
