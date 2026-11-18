'use strict';
/**
 * Vehicle Data 0.2.0 - mileage, service due (CBS), the car's service history, check-control
 * messages, tyre pressures, fault memory and DPF values. Read-only. Starts with the car and
 * keeps a JSON snapshot in its data directory, which the BMW AI companion agent passes on
 * to the private Pi.
 *
 * Nothing is written to any control unit: no CBS reset, no fault clearing. Diagnostic
 * requests are limited to the two read services 0x19 (fault memory) and 0x22 (DPF values)
 * by ReadOnlyDiag below.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Diag } = require('./kit/diag');
const { DidReader } = require('./kit/dids');
const { VehicleSnapshot, CBS_FIELDS } = require('./vehicle_snapshot.js');
const { FaultState } = require('./vehicle_faults.js');
const DPF = require('./dpf_dids.js');

const SECURE = 'de.bmw.infrastructure.SecureMileage';
const SUPREME = 'de.bmw.infrastructure.MileageSupreme';
const CBS = 'de.bmw.infotainment.ConditionBasedServicesLegacy';
const HISTORY = 'com.harman.infotainment.systemfunctions.servicehistory.ServiceHistory';
const HISTORY_INSTANCE = 'SystemFunctionsServiceHistoryInst1';
const CHECK_CONTROL = 'de.bmw.infotainment.checkcontrol.CheckControlMaster';
const KOMBI = 'de.bmw.infotainment.KombiInterface_2';
const TPMS = 'de.bmw.infotainment.vehicle.TPMSInternalData';
const REQUEST_FILE = 'bmw-vehicle-request.json';
const HISTORY_EVERY_MS = 6 * 3600 * 1000;
const DTC_PARAMS = [0x02, 0x0C];               // reportDTCByStatusMask: pending + confirmed
const DTC_AUTO_AFTER_MS = 90 * 1000;           // once per start (= per drive)
const DPF_PRIMARY_MS = 5 * 60 * 1000, DPF_SECONDARY_MS = 30 * 60 * 1000;
const W = 1600, H = 520;
const C = { bg: '#0a101b', card: '#182333', text: '#f5f7fb', dim: '#a6b5c9', over: '#ff7a7a', warn: '#f0af67' };
const EN = { OELSERVICE: 'Engine oil', BREMSBELAEGE_V: 'Brake pads front', BREMSBELAEGE_H: 'Brake pads rear',
    BREMSFLUESSIGKEIT: 'Brake fluid', MIKROFILTER: 'Microfilter', DIESELPARTIKELFILTER: 'Diesel particulate filter',
    GETRIEBEOEL: 'Gearbox oil', GETRIEBEOEL_HAUPTGETRIEBE: 'Gearbox oil', ZUENDKERZEN: 'Spark plugs',
    ZUENDKERZEN_ADAPTIV: 'Spark plugs', NOX_ADDITIV: 'AdBlue', SICHTPRUEFUNGEN: 'Vehicle check',
    SICHTPRUEFUNG_ADAPTIV: 'Vehicle check', KUEHLFLUESSIGKEIT: 'Coolant', HU_HAUPTUNTERSUCHUNG: 'Statutory inspection',
    AU_ABGASUNTERSUCHUNG: 'Emissions test' };
const WHEEL = { FRONT_LEFT: 'FL', FRONT_RIGHT: 'FR', REAR_LEFT: 'RL', REAR_RIGHT: 'RR', SPARE_TYRE: 'Spare' };
// The kit's fonts are ASCII only; the car's own texts are German.
const ascii = (s) => String(s).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss').replace(/[^\x20-\x7e]/g, '?');
const km = (n) => (n === null || n === undefined ? '--' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' km');

/** The head unit's diagnostic transport, limited to reading: 0x19 and 0x22 only. */
class ReadOnlyDiag extends Diag {
    async send(target, sid, data, opts) {
        if (sid !== 0x19 && sid !== 0x22) throw new Error('Vehicle Data only reads (refused service 0x' + sid.toString(16) + ')');
        if (sid === 0x19 && (!data || data[0] !== 0x02)) throw new Error('Vehicle Data only reads the fault memory by status mask');
        return super.send(target, sid, data, opts);
    }
}

mgu.run({
    async start(ctx) {
        const { ui, log, signals } = ctx;
        const snap = new VehicleSnapshot({ dir: ctx.dataDir, version: (ctx.spec && ctx.spec.version) || '' });
        const faults = new FaultState();
        snap.extra = () => faults.document();
        const flush = () => { try { snap.flush(); } catch (e) { log.warn('vehicle snapshot: ' + e); } };
        let page = 0, historyProxy = null, historyBusy = false, kombi = null, notice = '';
        let diag = null, dids = null, diagBusy = false, lastRequest = null, lastSecondary = 0;
        const shapes = {};
        const pause = (ms) => new Promise((r) => setTimeout(r, ms));
        // Log the raw shape of each signal once, to check units against iDrive's own screens.
        const firstRaw = (name, v) => { if (!shapes[name]) { shapes[name] = true; log.info('vehicle raw ' + name + ': ' + JSON.stringify(v).slice(0, 600)); } };

        const watch = (iface, handlers, opts) => signals.watch(iface, '1', handlers, log, opts)
            .then((s) => { snap.available(iface.split('.').pop(), !s.error, s.error); flush(); return s; })
            .catch((e) => { snap.available(iface.split('.').pop(), false, e); flush(); });
        watch(SECURE, { mileage: (v) => { firstRaw('SecureMileage', v); snap.secureMileage(v); flush(); } }, { pollMs: 5 * 60000 });
        watch(SUPREME, { mileageSupreme: (v) => { firstRaw('MileageSupreme', v); snap.mileageSupreme(v); flush(); } }, { pollMs: 5 * 60000 });
        const cbsHandlers = {};
        for (const f of CBS_FIELDS) cbsHandlers[f] = (v) => { firstRaw(f, v); snap.cbs(f, v); flush(); };
        watch(CBS, cbsHandlers);
        watch(TPMS, { tpmsInternalLastValues: (v) => { firstRaw('tpmsInternalLastValues', v); faults.setTyres(v); flush(); } }, { pollMs: 60000 });

        // ----- Check-control messages: event list plus the text the car itself shows -----
        async function ccText(id) {
            try {
                if (!kombi) kombi = await signals.proxy(KOMBI, '1');
                const r = await signals.call(kombi, 'requestCCMessage', { id }, 5000);
                firstRaw('requestCCMessage', r);
                faults.ccText(r);
            } catch (e) { log.warn('cc text ' + id + ': ' + e); }
            flush();
        }
        watch(CHECK_CONTROL, { basicList: (v) => {
            firstRaw('basicList', v);
            const e = faults.ccEvent(v);
            if (e && e.active && faults.needsText(e.id)) ccText(e.id);
            flush();
        } }, { pollMs: 60000 });
        watch(KOMBI, { newCCMessage: (v) => { firstRaw('newCCMessage', v); faults.ccText(v); flush(); } });

        // ----- Service history (method on its own instance) -----
        async function readHistory(reason) {
            if (historyBusy) return;
            historyBusy = true;
            try {
                if (!historyProxy) {
                    historyProxy = await signals.proxy(HISTORY, HISTORY_INSTANCE);
                    await signals.on(historyProxy, 'serviceHistoryUpdated', () => readHistory('updated'), log);
                }
                const r = await signals.call(historyProxy, 'readServiceHistory', {}, 8000);
                firstRaw('readServiceHistory', r);
                snap.serviceHistory(r);
                snap.available('ServiceHistory', true);
                notice = 'Service history read (' + reason + ')';
            } catch (e) {
                snap.available('ServiceHistory', false, e);
                notice = 'Service history not readable: ' + ascii(String(e)).slice(0, 80);
                log.warn('service history: ' + e);
            } finally { historyBusy = false; flush(); }
        }
        setTimeout(() => readHistory('start'), 8000);
        setInterval(() => readHistory('periodic'), HISTORY_EVERY_MS);

        // ----- Diagnostic reads: fault memory (0x19) and DPF values (0x22), one at a time -----
        async function withDiag(fn) {
            if (diagBusy) return false;
            diagBusy = true;
            try {
                if (!diag) { diag = new ReadOnlyDiag(signals, log); diag.quiet = true; await diag.init(); if (diag.p) dids = new DidReader(diag, { ecu: DPF.ECU }); }
                if (!diag.p) throw new Error(diag.error || 'diagnostic transport unavailable');
                await fn();
                snap.available('Diagnostics', true);
                return true;
            } catch (e) { snap.available('Diagnostics', false, e); log.warn('diagnostics: ' + e); return false; }
            finally { diagBusy = false; flush(); }
        }
        async function readFaultMemory(requestId) {
            for (let attempt = 0; attempt < 10 && diagBusy; attempt++) await pause(2000);   // DPF read running
            notice = 'Reading fault memory ...';
            const ok = await withDiag(async () => {
                let replies;
                try { replies = await diag.functional(0x19, DTC_PARAMS, { idleMs: 4000, maxMs: 30000 }); }
                catch (e) { faults.setDtc(requestId, null, DTC_PARAMS, e); throw e; }
                const r = faults.setDtc(requestId, replies, DTC_PARAMS, null);
                notice = 'Fault memory: ' + r.dtcs.length + ' codes from ' + r.ecus.length + ' units';
                log.info('fault memory read: ' + r.ecus.length + ' units, ' + r.dtcs.length + ' codes');
            });
            if (!ok) { notice = 'Fault memory not readable'; if (!faults.dtc || faults.dtc.requestId !== requestId) faults.setDtc(requestId, null, DTC_PARAMS, diagBusy ? 'busy' : (diag && diag.error) || 'diagnostic transport unavailable'); flush(); }
        }
        async function readDpf() {
            const secondary = Date.now() - lastSecondary > DPF_SECONDARY_MS;
            await withDiag(async () => {
                for (const field of DPF.READINGS) {
                    if (field.tier === 'secondary' && !secondary) continue;
                    const v = await dids.read(field.request);
                    if (v !== null) faults.setDpf(field.name, v);
                    await pause(180);
                }
                if (secondary) lastSecondary = Date.now();
            });
        }
        setTimeout(() => readFaultMemory('start'), DTC_AUTO_AFTER_MS);
        setTimeout(() => { readDpf(); setInterval(readDpf, DPF_PRIMARY_MS); }, 45 * 1000);

        // The companion agent asks for a fresh fault-memory read by dropping a request file here.
        setInterval(() => {
            let req;
            try { req = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, REQUEST_FILE), 'utf8')); } catch (e) { return; }
            if (!req || typeof req.id !== 'string' || req.id === lastRequest || req.type !== 'faultMemory') return;
            if (Date.parse(req.at) < Date.now() - 5 * 60000) return;
            lastRequest = req.id;
            readFaultMemory(req.id.slice(0, 64));
        }, 3000);

        ui.onClick('BTN_PAGE', () => { page = (page + 1) % 4; });
        ui.onClick('BTN_REFRESH', () => { readHistory('button'); readFaultMemory('button'); });
        if (typeof ctx.onTab === 'function') ctx.onTab((i) => { if (i >= 0 && i < 4) page = i; });

        const label = (cv, t, x, y, size, colour, opt) => cv.text(ascii(t), x, y, size, colour || C.text, Object.assign({ literal: true }, opt || {}));
        const card = (cv, x, w, title) => { cv.roundRect(x, 112, w, 350, 17, C.card); label(cv, title, x + 30, 158, 24, C.dim); };
        function overview(cv) {
            const doc = snap.document(), m = doc.mileage;
            card(cv, 43, 520, 'MILEAGE');
            label(cv, m ? km(m.km) : '--', 73, 240, 52, C.text, { font: 'bold' });
            label(cv, m ? 'from ' + m.source : 'no value from the car yet', 73, 290, 20, C.dim);
            label(cv, 'Compare once with the instrument cluster.', 73, 430, 18, C.dim);
            card(cv, 593, 964, 'SERVICE DUE (CBS)');
            if (!doc.cbs.length) label(cv, 'No service messages received yet.', 623, 220, 24, C.dim);
            doc.cbs.slice(0, 6).forEach((c, i) => {
                const y = 210 + i * 44;
                label(cv, EN[c.scope] || c.scope || c.field, 623, y, 23, C.text);
                label(cv, (c.dueDate ? c.dueDate + '   ' : '') + km(c.remainingKm), 1527, y, 23, c.remainingKm === 0 ? C.over : C.text, { align: 'right', font: 'bold' });
            });
        }
        function history(cv) {
            const h = snap.document().serviceHistory;
            card(cv, 43, 1514, 'SERVICE HISTORY IN THE CAR');
            if (!h) label(cv, historyBusy ? 'Reading...' : 'Not read yet.', 73, 220, 24, C.dim);
            else if (!h.sets.length) label(cv, 'No entries (' + (h.status || 'unknown') + ')', 73, 220, 24, C.dim);
            else h.sets.slice(0, 6).forEach((s, i) => {
                const y = 210 + i * 44;
                label(cv, (s.date || '----') + '   ' + km(s.km), 73, y, 23, C.text, { font: 'bold' });
                label(cv, s.services.map((x) => EN[x.scope] || x.label).join(', ').slice(0, 70), 560, y, 21, C.dim);
            });
        }
        function messages(cv) {
            const f = faults.document();
            card(cv, 43, 900, 'CHECK-CONTROL MESSAGES');
            if (!f.checkControl.active.length) label(cv, 'No active message.', 73, 220, 24, C.dim);
            f.checkControl.active.slice(0, 6).forEach((c, i) => label(cv, (c.text || 'Message ' + c.id).slice(0, 52), 73, 210 + i * 44, 23, C.warn));
            card(cv, 973, 584, 'FAULT MEMORY');
            const d = f.faultMemory;
            if (!d) label(cv, diagBusy ? 'Reading...' : 'Read after start.', 1003, 220, 24, C.dim);
            else if (d.error) label(cv, 'Not readable', 1003, 220, 24, C.over);
            else {
                label(cv, String(d.dtcs.length), 1003, 260, 64, d.dtcs.some((x) => x.active) ? C.over : C.text, { font: 'bold' });
                label(cv, 'codes in ' + d.ecus.filter((e) => e.count).length + ' of ' + d.ecus.length + ' units', 1003, 310, 22, C.dim);
                label(cv, 'Details on your BMW AI website.', 1003, 430, 18, C.dim);
            }
        }
        function tyres(cv) {
            const f = faults.document();
            card(cv, 43, 900, 'TYRES');
            if (!f.tyres) label(cv, 'No tyre data yet.', 73, 220, 24, C.dim);
            else f.tyres.wheels.forEach((w, i) => {
                const y = 210 + i * 50, low = w.pressureBar !== null && w.targetBar && w.pressureBar < w.targetBar * 0.9;
                label(cv, WHEEL[w.position] || w.position, 73, y, 24, C.text, { font: 'bold' });
                label(cv, (w.pressureBar === null ? '--' : w.pressureBar.toFixed(2) + ' bar') + (w.targetBar ? '  (target ' + w.targetBar.toFixed(2) + ')' : ''), 220, y, 24, low ? C.over : C.text);
                label(cv, w.temperatureC === null ? '' : w.temperatureC + ' C', 900, y, 22, C.dim, { align: 'right' });
            });
            card(cv, 973, 584, 'PARTICULATE FILTER');
            const p = f.dpf;
            if (!p) label(cv, 'No values yet.', 1003, 220, 24, C.dim);
            else [['Soot', p.soot, ' g'], ['Ash', p.ash, ' g'], ['Since regen', p.distance, ' km'], ['Regenerations', p.regenCount, '']].forEach((r, i) => {
                label(cv, r[0], 1003, 210 + i * 50, 23, C.dim);
                label(cv, r[1] === undefined ? '--' : (Math.round(r[1] * 10) / 10) + r[2], 1527, 210 + i * 50, 23, C.text, { align: 'right', font: 'bold' });
            });
        }
        function render() {
            const cv = ctx.canvas(W, H).clear(C.bg);
            label(cv, 'VEHICLE DATA', 50, 93, 29, C.text, { font: 'bold' });
            if (notice) label(cv, notice, 1550, 93, 18, C.dim, { align: 'right' });
            [overview, history, messages, tyres][page](cv);
            label(cv, 'Read only. Values go to your private BMW AI server.', 52, 500, 18, C.dim);
            G.frame(cv, ctx.theme(), ['Overview', 'Service history', 'Messages', 'Tyres & DPF'], page, []);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 1, render);
        render().catch((e) => log.warn('vehicle data first frame: ' + e));
    },
});
