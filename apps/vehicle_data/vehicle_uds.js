'use strict';

// ReadDataByIdentifier definitions and positive 2021 BMW 3 Series captures:
// https://github.com/OBDb/BMW-3-Series/tree/414dd76abbbb592dcd64b486f7d045b9fa4d43e2/tests/test_cases/2021
const { replyTo } = require('./kit/diag');
const ODOMETER = { ecu: 0x12, did: 0x558E, length: 4 };
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

function readMileage(diag) {
    return read(diag, ODOMETER, data => {
        const km = data.readUInt32BE(0);
        return km > 0 && km < 2000000 ? km : null;
    });
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

module.exports = { RDC, readMileage, readWheel };
