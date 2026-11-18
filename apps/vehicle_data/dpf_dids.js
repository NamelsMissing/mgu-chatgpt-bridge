'use strict';
// Copied from NamelsMissing/mgu-apps apps/dpf_monitor/dpf-dids.js (same author, GPL-3.0-only).
// BMW G21 B47 D83BX7C0.prg SG_FUNKTIONEN, read-only UDS 22 values.
// More frequently used "primary" values are polled each cycle;
// secondary values are staggered to minimise gateway traffic.
// These do not prove that a service regeneration routine is safe or available.
const ECU = 0x12;
const READINGS = [
    { name: 'soot', tier: 'primary', request: { did: '44BE', bytes: 2, factor: 0.01525902, min: 0, max: 250, timeoutMs: 2200 } },
    { name: 'pressure', tier: 'primary', request: { did: '44ED', bytes: 2, factor: 0.04577707, offset: -1000, min: -100, max: 1500, timeoutMs: 2200 } },
    { name: 'temperature', tier: 'primary', request: { did: '4502', bytes: 2, factor: 0.03128099, offset: -50, min: -50, max: 1100, timeoutMs: 2200 } },
    { name: 'distance', tier: 'primary', request: { did: '44BF', bytes: 4, factor: 0.001, min: 0, max: 100000, timeoutMs: 2200 } },
    { name: 'ash', tier: 'secondary', request: { did: '44BD', bytes: 2, factor: 0.01525902, min: 0, max: 500, timeoutMs: 2200 } },
    { name: 'pressureFiltered', tier: 'secondary', request: { did: '44FA', bytes: 2, factor: 0.04577707, offset: -1000, min: -100, max: 1500, timeoutMs: 2200 } },
    { name: 'sootMeasured', tier: 'secondary', request: { did: '44AC', bytes: 2, factor: 0.1, min: 0, max: 250, timeoutMs: 2200 } },
    { name: 'sootModel', tier: 'secondary', request: { did: '44C1', bytes: 2, factor: 0.01, min: 0, max: 250, timeoutMs: 2200 } },
    { name: 'regenOdo1', tier: 'secondary', request: { did: '44D1', bytes: 4, factor: 0.001, min: 0, max: 1000000, timeoutMs: 2200 } },
    { name: 'regenOdo2', tier: 'secondary', request: { did: '44D2', bytes: 4, factor: 0.001, min: 0, max: 1000000, timeoutMs: 2200 } },
    { name: 'regenOdo3', tier: 'secondary', request: { did: '44D3', bytes: 4, factor: 0.001, min: 0, max: 1000000, timeoutMs: 2200 } },
    { name: 'regenOdo4', tier: 'secondary', request: { did: '44D4', bytes: 4, factor: 0.001, min: 0, max: 1000000, timeoutMs: 2200 } },
    { name: 'regenOdo5', tier: 'secondary', request: { did: '44D5', bytes: 4, factor: 0.001, min: 0, max: 1000000, timeoutMs: 2200 } },
    { name: 'regenCount', tier: 'secondary', request: { did: '44B8', bytes: 2, min: 0, max: 65535, timeoutMs: 2200 } },
    { name: 'regenAverage', tier: 'secondary', request: { did: '44C7', bytes: 2, min: 0, max: 65535, timeoutMs: 2200 } },
    { name: 'regenHours', tier: 'secondary', request: { did: '44B7', bytes: 4, factor: 1 / 3600, min: 0, max: 20000, timeoutMs: 2200 } },
    { name: 'regenRequestCode', tier: 'secondary', request: { did: '44BB', bytes: 1, min: 0, max: 255, timeoutMs: 2200 } },
    { name: 'regenInhibitCode', tier: 'secondary', request: { did: '44C2', bytes: 1, min: 0, max: 255, timeoutMs: 2200 } },
];
module.exports = { ECU, READINGS };
