'use strict';
/**
 * Vehicle Data 0.1.0 - mileage, service due (CBS) and the car's service history,
 * read-only over SOME/IP. Starts with the car and keeps a small JSON snapshot in its
 * data directory, which the BMW AI companion agent passes on to the private Pi.
 *
 * Nothing is written to any control unit: no CBS reset, no UDS. The screen shows the
 * same values the snapshot holds, so they can be compared with iDrive's own
 * "Service requirements" page once.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { VehicleSnapshot, CBS_FIELDS } = require('./vehicle_snapshot.js');

const SECURE = 'de.bmw.infrastructure.SecureMileage';
const SUPREME = 'de.bmw.infrastructure.MileageSupreme';
const CBS = 'de.bmw.infotainment.ConditionBasedServicesLegacy';
const HISTORY = 'com.harman.infotainment.systemfunctions.servicehistory.ServiceHistory';
const HISTORY_INSTANCE = 'SystemFunctionsServiceHistoryInst1';
const HISTORY_EVERY_MS = 6 * 3600 * 1000;
const W = 1600, H = 520;
const C = { bg: '#0a101b', card: '#182333', text: '#f5f7fb', dim: '#a6b5c9', track: '#3b5068', due: '#f0af67', over: '#ff7a7a' };
// The kit's fonts are ASCII only: English labels on the head unit.
const EN = { OELSERVICE: 'Engine oil', BREMSBELAEGE_V: 'Brake pads front', BREMSBELAEGE_H: 'Brake pads rear',
    BREMSFLUESSIGKEIT: 'Brake fluid', MIKROFILTER: 'Microfilter', DIESELPARTIKELFILTER: 'Diesel particulate filter',
    GETRIEBEOEL: 'Gearbox oil', GETRIEBEOEL_HAUPTGETRIEBE: 'Gearbox oil', ZUENDKERZEN: 'Spark plugs',
    ZUENDKERZEN_ADAPTIV: 'Spark plugs', NOX_ADDITIV: 'AdBlue', SICHTPRUEFUNGEN: 'Vehicle check',
    SICHTPRUEFUNG_ADAPTIV: 'Vehicle check', KUEHLFLUESSIGKEIT: 'Coolant', HU_HAUPTUNTERSUCHUNG: 'Statutory inspection',
    AU_ABGASUNTERSUCHUNG: 'Emissions test' };
const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '?');
const km = (n) => (n === null || n === undefined ? '--' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' km');

mgu.run({
    async start(ctx) {
        const { ui, log, signals } = ctx;
        const snap = new VehicleSnapshot({ dir: ctx.dataDir, version: (ctx.spec && ctx.spec.version) || '' });
        const flush = () => { try { snap.flush(); } catch (e) { log.warn('vehicle snapshot: ' + e); } };
        let page = 0, historyProxy = null, historyBusy = false, notice = '';
        const shapes = {};
        // Log the raw shape of each signal once, to check units against iDrive's own screen.
        const firstRaw = (name, v) => { if (!shapes[name]) { shapes[name] = true; log.info('vehicle raw ' + name + ': ' + JSON.stringify(v).slice(0, 600)); } };

        const watch = (iface, handlers, opts) => signals.watch(iface, '1', handlers, log, opts)
            .then((s) => { snap.available(iface.split('.').pop(), !s.error, s.error); flush(); return s; })
            .catch((e) => { snap.available(iface.split('.').pop(), false, e); flush(); });
        watch(SECURE, { mileage: (v) => { firstRaw('SecureMileage', v); snap.secureMileage(v); flush(); } }, { pollMs: 5 * 60000 });
        watch(SUPREME, { mileageSupreme: (v) => { firstRaw('MileageSupreme', v); snap.mileageSupreme(v); flush(); } }, { pollMs: 5 * 60000 });
        const cbsHandlers = {};
        for (const f of CBS_FIELDS) cbsHandlers[f] = (v) => { firstRaw(f, v); snap.cbs(f, v); flush(); };
        watch(CBS, cbsHandlers);

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

        ui.onClick('BTN_PAGE', () => { page = (page + 1) % 2; });
        ui.onClick('BTN_REFRESH', () => readHistory('button'));
        if (typeof ctx.onTab === 'function') ctx.onTab((i) => { if (i === 0 || i === 1) page = i; });

        const label = (cv, t, x, y, size, colour, opt) => cv.text(ascii(t), x, y, size, colour || C.text, Object.assign({ literal: true }, opt || {}));
        function overview(cv) {
            const doc = snap.document(), m = doc.mileage;
            cv.roundRect(43, 112, 520, 350, 17, C.card);
            label(cv, 'MILEAGE', 73, 158, 24, C.dim);
            label(cv, m ? km(m.km) : '--', 73, 240, 52, C.text, { font: 'bold' });
            label(cv, m ? 'from ' + m.source : 'no value from the car yet', 73, 290, 20, C.dim);
            label(cv, 'Compare once with the instrument cluster.', 73, 430, 18, C.dim);
            cv.roundRect(593, 112, 964, 350, 17, C.card);
            label(cv, 'SERVICE DUE (CBS)', 623, 158, 24, C.dim);
            if (!doc.cbs.length) label(cv, 'No service messages received yet.', 623, 220, 24, C.dim);
            doc.cbs.slice(0, 6).forEach((c, i) => {
                const y = 210 + i * 44, over = c.remainingKm === 0;
                label(cv, EN[c.scope] || c.scope || c.field, 623, y, 23, C.text);
                label(cv, (c.dueDate ? c.dueDate + '   ' : '') + km(c.remainingKm), 1527, y, 23, over ? C.over : C.text, { align: 'right', font: 'bold' });
            });
        }
        function history(cv) {
            const doc = snap.document(), h = doc.serviceHistory;
            cv.roundRect(43, 112, 1514, 350, 17, C.card);
            label(cv, 'SERVICE HISTORY IN THE CAR', 73, 158, 24, C.dim);
            if (!h) label(cv, historyBusy ? 'Reading...' : 'Not read yet.', 73, 220, 24, C.dim);
            else if (!h.sets.length) label(cv, 'No entries (' + (h.status || 'unknown') + ')', 73, 220, 24, C.dim);
            else h.sets.slice(0, 6).forEach((s, i) => {
                const y = 210 + i * 44;
                label(cv, (s.date || '----') + '   ' + km(s.km), 73, y, 23, C.text, { font: 'bold' });
                label(cv, s.services.map((x) => EN[x.scope] || x.label).join(', ').slice(0, 70), 560, y, 21, C.dim);
            });
        }
        function render() {
            const cv = ctx.canvas(W, H).clear(C.bg);
            label(cv, 'VEHICLE DATA', 50, 93, 29, C.text, { font: 'bold' });
            if (notice) label(cv, notice, 1550, 93, 18, C.dim, { align: 'right' });
            if (page === 0) overview(cv); else history(cv);
            label(cv, 'Read only. Values go to your private BMW AI server.', 52, 500, 18, C.dim);
            G.frame(cv, ctx.theme(), ['Overview', 'Service history'], page, []);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 1, render);
        render().catch((e) => log.warn('vehicle data first frame: ' + e));
    },
});
