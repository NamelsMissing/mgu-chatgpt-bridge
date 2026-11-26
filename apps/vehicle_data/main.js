'use strict';
/**
 * Vehicle Data - mileage, service due (CBS), the car's service history, check-control
 * messages, tyre pressures, fault memory and DPF values. Read-only. Starts with the car and
 * keeps a JSON snapshot in its data directory, which the BMW AI companion agent passes on
 * to the private Pi.
 *
 * Nothing is written to any control unit: no CBS reset, no fault clearing. Diagnostic
 * requests are limited to the two read services 0x19 (fault memory) and 0x22 (vehicle measurements)
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
const VUDS = require('./vehicle_uds.js');

const SECURE = 'de.bmw.infrastructure.SecureMileage';
const SUPREME = 'de.bmw.infrastructure.MileageSupreme';
const CBS = 'de.bmw.infotainment.ConditionBasedServicesLegacy';
const HISTORY = 'com.harman.infotainment.systemfunctions.servicehistory.ServiceHistory';
const HISTORY_INSTANCE = 'SystemFunctionsServiceHistoryInst1';
const CHECK_CONTROL = 'de.bmw.infotainment.checkcontrol.CheckControlMaster';
const KOMBI = 'de.bmw.infotainment.KombiInterface_2';
const TPMS = 'de.bmw.infotainment.vehicle.TPMSInternalData';
const DiagnosticQueue = require('./diagnostic_queue');
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
        const proxies = require('../manifest.json').proxies;
        const dataDir = path.resolve(__dirname, '..', '..', 'data');
        const snap = new VehicleSnapshot({ dir: dataDir, onError: (e) => log.warn('Vehicle Data IPC: ' + e), version: (ctx.spec && ctx.spec.version) || '' });
        const faults = new FaultState();
        snap.extra = () => faults.document();
        const flush = (force) => { try { snap.flush(force); } catch (e) { log.warn('vehicle snapshot: ' + e); } };
        flush(true);
        setInterval(() => flush(true), 20000);
        let page = 0, historyProxy = null, historyBusy = false, kombi = null, notice = '';
        let diag = null, dids = null, lastRequest = null, lastSecondary = 0, dpfRunning=false, queueState=null, previousFaultScan=null;
        const queue=new DiagnosticQueue(state=>{
            queueState=state;
            snap.stage('UDS','queue',state);
            flush();
        });
        const pause = (ms) => new Promise((r) => setTimeout(r, ms));
        const sample = (name, raw, validCount) => {
            snap.receivedValue(name,raw,validCount);
            flush();
        };
        // Reads are restricted to fields already declared with r in the manifest.
        const watch = (iface, handlers, opts, attempt) => {
            const name = iface.split('.').pop();
            const declared = (proxies[iface] || {}).attributes || {};
            const requested = opts && opts.readFields || [];
            const reads = requested.filter(field => /r/.test(declared[field] || ''));
            const optional = opts && opts.optionalFields || [];
            const getterOnly = (opts && opts.readOnlyFields || []).concat(optional.filter(field=>!/s/.test(declared[field]||'')));
            const enabledHandlers = {};
            Object.keys(handlers).forEach(field => {
                const key=name+'.'+field;
                const canRead = /r/.test(declared[field]||'');
                const canSubscribe = /s/.test(declared[field]||'');
                snap.stage(key,'manifestRead',canRead);
                snap.stage(key,'manifestSubscribe',canSubscribe);
                if (getterOnly.indexOf(field)!==-1) snap.stage(key,'subscription','not_requested');
                if (optional.indexOf(field)!==-1 ? canRead || canSubscribe : getterOnly.indexOf(field)===-1 || canRead) {
                    enabledHandlers[field] = handlers[field];
                } else {
                    snap.available(name+'.'+field,false,'Getter nicht für dieses Installationspaket freigegeben');
                }
            });
            if (!Object.keys(enabledHandlers).length) {
                snap.available(name,false,'Kein geprüfter Getter im Installationsmanifest');
                flush();
                return Promise.resolve(null);
            }
            const configured = Object.assign({initialRead:true,strictGetters:true,maxGetterFailures:3},opts,{readFields:reads,readOnlyFields:getterOnly});
            return signals.watch(iface, '1', enabledHandlers, log, Object.assign(configured, {
                onTrace: (field,stage,value) => { snap.stage(field==='*'?name:name+'.'+field,stage,value);flush(); },
                onAvailability: (ok) => { snap.stage(name,'provider',ok);snap.available(name,ok);flush(); },
                onError: (field, stage) => { snap.available(name, snap.state.signals[name] && snap.state.signals[name].available, stage+' '+field);flush(); },
            })).then(async (sub) => {
                if (iface===KOMBI && !sub.error) kombi=sub.proxy;
                snap.stage(name,'proxy',sub.error?'failed':'ready');
                snap.available(name, sub.available, sub.error ? 'Proxy-Initialisierung fehlgeschlagen' : null);
                flush();
                if (sub.error && (attempt || 0) < 3) {
                    await sub.shutdown();
                    setTimeout(() => watch(iface,handlers,opts,(attempt || 0)+1), 5000*Math.pow(2,attempt || 0));
                }
                return sub;
            });
        };
        watch(SECURE, { mileage: (v) => {
            snap.secureMileage(v); snap.stage('SecureMileage.mileage','decodeReason',snap.state.secure.reason); sample('SecureMileage.mileage',v,snap.state.secure.km === null ? null : 1);
        } }, { readFields:['mileage'],pollMs:5*60000, retryAfterMs:10*60000 });
        watch(SUPREME, { mileageSupreme: (v) => {
            snap.mileageSupreme(v); snap.stage('MileageSupreme.mileageSupreme','decodeReason',snap.state.supreme.reason); sample('MileageSupreme.mileageSupreme',v,snap.state.supreme.km === null ? null : 1);
        } }, { readFields:['mileageSupreme'],pollMs:5*60000, retryAfterMs:10*60000 });
        watch('de.bmw.infrastructure.VehicleInformation', { Range: (v) =>
            sample('VehicleInformation.Range',v,snap.range(v) === null ? null : 1),
        }, {readFields:['Range'],readOnlyFields:['Range'],pollMs:5*60000});
        const cbsHandlers = {};
        for (const f of CBS_FIELDS) cbsHandlers[f] = (v) => {
            snap.cbs(f, v); sample('ConditionBasedServicesLegacy.'+f,v,snap.state.cbs[f] ? 1 : null);
        };
        watch(CBS, cbsHandlers);
        watch(TPMS, { tpmsInternalLastValues: (v) => {
            const wheels=faults.setTyres(v);
            const count=wheels.filter(w=>w.pressureBar!==null||w.targetBar!==null||w.temperatureC!==null).length;
            sample('TPMSInternalData.tpmsInternalLastValues',v,count || null);
        } }, { readFields:['tpmsInternalLastValues'],pollMs:60000,retryAfterMs:10*60000 });
        watch('de.bmw.infotainment.vehicle.TPMS', {
            statusTyrePressure:(v)=>sample('TPMS.statusTyrePressure',v,null),
            statusTargetTyrePressure:(v)=>sample('TPMS.statusTargetTyrePressure',v,null),
        }, {readFields:['statusTyrePressure','statusTargetTyrePressure'],
            readOnlyFields:['statusTyrePressure','statusTargetTyrePressure'],pollMs:60000});

        // The complete list defines presence. Legacy events still supply ECU attribution and transitions.
        const textAttempts = new Map(), textPending = new Set();
        const requestKey = 'KombiInterface_2.requestCCMessage';
        const ccMethods = (proxies[KOMBI] || {}).methods || [];
        const canRequestCc = ccMethods.indexOf('requestCCMessage')!==-1;
        snap.stage(requestKey,'manifestMethod',canRequestCc);
        async function ccText(id) {
            if (!canRequestCc || !kombi || !faults.needsText(id) || textPending.size >= 4 || textPending.has(id)) return;
            const prev = textAttempts.get(id);
            if (prev && Date.now()-prev < 60000) return;
            if (textAttempts.size >= 80) textAttempts.delete(textAttempts.keys().next().value);
            textAttempts.set(id,Date.now());
            textPending.add(id);
            try {
                const key=requestKey;
                snap.stage(key,'getter','pending');
                const r = await signals.call(kombi, 'requestCCMessage', { id }, 5000);
                snap.stage(key,'getter','ok');
                const text = faults.ccText(r,key,id);
                if (text && text.id === id) snap.available('CheckControlText',true);
                sample('KombiInterface_2.requestCCMessage',r,text && text.id === id ? 1 : null);
            } catch (e) {
                snap.stage('KombiInterface_2.requestCCMessage','getter','failed');
                snap.available('CheckControlText',false,'requestCCMessage fehlgeschlagen');
                flush();
            } finally { textPending.delete(id); }
        }
        const ccRows = (source, v, origin) => {
            const result = faults.ccBatch(v,source,origin);
            sample(source,v,result.rejected ? null : result.valid);
            const active = result.rows.filter(row=>row.active).sort((a,b)=>(textAttempts.get(a.id)||0)-(textAttempts.get(b.id)||0));
            for (const row of active) ccText(row.id);
        };
        watch(CHECK_CONTROL, { basicList: (v,origin) => ccRows('CheckControlMaster.basicList',v,origin) },
            {readFields:['basicList'],pollMs:60000,retryAfterMs:5*60000});
        watch(KOMBI, {
            newCCMessage: (v) => {
                const key = 'KombiInterface_2.newCCMessage';
                const message = faults.ccText(v,key);
                // A notifier supplies text immediately. Presence still comes from the list/event,
                // since the new-message union does not contain an ActiveState.
                sample(key,v,message ? 1 : null);
            },
            ccList: (v,origin) => ccRows('KombiInterface_2.ccList',v,origin),
            ccListRiskClass: (v,origin) => ccRows('KombiInterface_2.ccListRiskClass',v,origin),
            cbsDataServiceList: (v) => {
                const rows=snap.cbsList(v);
                sample('KombiInterface_2.cbsDataServiceList',v,rows===null?null:rows.length);
            },
        }, {readFields:['ccList','ccListRiskClass','cbsDataServiceList'],readOnlyFields:['cbsDataServiceList'],optionalFields:['ccList','ccListRiskClass'],pollMs:60000});

        // ----- Service history (method on its own instance) -----
        let historyRetries=0;
        async function readHistory(reason) {
            if (historyBusy) return;
            historyBusy = true;
            try {
                if (!historyProxy) {
                    historyProxy = await signals.proxy(HISTORY, HISTORY_INSTANCE);
                    try { await signals.on(historyProxy, 'serviceHistoryUpdated', () => readHistory('updated'), log); }
                    catch(e) { snap.available('ServiceHistorySubscription',false,'serviceHistoryUpdated konnte nicht abonniert werden'); }
                }
                snap.stage('ServiceHistory.readServiceHistory','manifestMethod',true);
                snap.stage('ServiceHistory.readServiceHistory','getter','pending');
                const r = await signals.call(historyProxy, 'readServiceHistory', {}, 8000);
                snap.stage('ServiceHistory.readServiceHistory','getter','ok');
                snap.serviceHistory(r);
                const h=snap.state.history;
                sample('ServiceHistory.readServiceHistory',r,h.status==='E_OK'?h.sets.length:null);
                if (!h.status) throw new Error('Antwortformat von readServiceHistory unbekannt');
                historyRetries=0;
                snap.available('ServiceHistory', true);
                notice = 'Service history read (' + reason + ')';
            } catch (e) {
                const previous=historyProxy;
                historyProxy = null;
                if (previous && previous.shutdown) Promise.resolve().then(()=>previous.shutdown()).catch(()=>{});
                snap.stage('ServiceHistory.readServiceHistory','getter','failed');
                snap.available('ServiceHistory', false, 'readServiceHistory fehlgeschlagen');
                if (historyRetries<3) setTimeout(()=>readHistory('retry'),5000*Math.pow(2,historyRetries++));
                notice = 'Service history not readable: ' + ascii(String(e)).slice(0, 80);
                log.warn('service history: ' + e);
            } finally { historyBusy = false; flush(); }
        }
        setTimeout(() => readHistory('start'), 8000);
        setInterval(() => readHistory('periodic'), HISTORY_EVERY_MS);

        // ----- Diagnostic reads: fault memory (0x19) and DPF values (0x22), one at a time -----
        function withDiag(kind, key, fn) {
            return queue.run(kind,key,async ()=>{
                if (!diag || diag.error) {
                    if (diag && diag.p && diag.p.shutdown) await Promise.resolve().then(() => diag.p.shutdown()).catch(() => {});
                    diag = new ReadOnlyDiag(signals, log);
                    diag.quiet = true;
                    await diag.init();
                    if (!diag.error) diag.on('available',ok=>{if(ok)resetMileageSources();});
                    if (!diag.error && diag.p) dids = new DidReader(diag, { ecu: DPF.ECU });
                }
                if (!diag.p || diag.error) throw new Error(diag.error || 'diagnostic transport unavailable');
                await fn();
                snap.available('Diagnostics',true);
            }).catch(e=>{
                snap.available('Diagnostics',false,'Diagnoseauftrag fehlgeschlagen oder Zeitlimit erreicht');
                throw e;
            });
        }
        async function readFaultMemory(requestId) {
            notice = 'Fault memory queued ...';
            try {
                let scan;
                await withDiag('fault',requestId,async ()=>{
                    notice = 'Reading fault memory ...';
                    scan = await diag.functional(0x19, DTC_PARAMS, {
                        idleMs:4000,maxMs:30000,maxRetries:1,callTimeoutMs:6000,
                    });
                });
                if (!scan) return; // Another invocation already owns this same local button request.
                const result=faults.setDtc(requestId,scan,DTC_PARAMS,null);
                if (!result.ecus.some(ecu=>ecu.ok)) {
                    result.error = result.ecus.length ? 'Kein Steuergerät hat positiv geantwortet' : 'Keine ECU-Antwort innerhalb des Diagnosefensters';
                }
                sample('UDS.1902',null,result.error?null:result.dtcs.length);
                if(!result.error) previousFaultScan=result;
                notice = result.error ? 'Fault memory not readable' : 'Fault memory: '+result.dtcs.length+' codes from '+result.ecus.length+' units';
            } catch(e) {
                faults.setDtc(requestId,null,DTC_PARAMS,e);
                notice = 'Fault memory: '+ascii(String(e.message||e)).slice(0,100);
            } finally { flush(true); }
        }
        async function readDpf() {
            if (dpfRunning) return;
            dpfRunning=true;
            const secondary = Date.now()-lastSecondary>DPF_SECONDARY_MS;
            let count=0;
            try {
                for (const field of DPF.READINGS) {
                    if (field.tier==='secondary' && !secondary) continue;
                    let value;
                    await withDiag('dpf',field.name,async ()=>{
                        // Keep read units, scaling and DID selection. Limit just
                        // this physical transaction so it can yield to a scan.
                        const request=Object.assign({},field.request,{diagOpts:Object.assign({},field.request.diagOpts,
                            {maxRetries:1,callTimeoutMs:5000,hardTimeoutMs:12000})});
                        value=await dids.read(request);
                        await pause(180);
                    });
                    if (value!==null && value!==undefined) { faults.setDpf(field.name,value); count++; }
                }
                if (secondary && count) lastSecondary=Date.now();
            } catch(e) { log.warn('DPF transport unavailable: '+e); }
            finally { sample('UDS.DPF',null,count||null);dpfRunning=false;flush(); }
        }
        // The existing TASU proxy also carries the two read-only fallbacks.
        // Each wheel yields the queue so a manual scan can take priority.
        const lastVehicleRead = {tyres:0};
        async function readVehicleMeasure(key, operation) {
            snap.stage(key,'getter','pending');
            let result;
            try {
                await withDiag('vehicle',key,async ()=>{ result = await operation(diag); });
            } catch (e) {
                result = {reason:'transport_or_queue'};
            }
            snap.stage(key,'getter',result.value === undefined ? 'failed' : 'ok');
            snap.stage(key,'decodeReason',result.reason || null);
            snap.available(key,result.value !== undefined,result.reason);
            // Raw RDC replies contain sensor identifiers. Only status and decoded
            // output leave this code, never those raw bytes.
            if (result.value !== undefined || /^(nrc_|unexpected_|invalid_value)/.test(result.reason)) {
                sample(key,null,result.value === undefined ? null : 1);
            } else flush();
            return result.value;
        }
        async function readVehicleFallback() {
            const primary=faults.tyres;
            const complete=primary && Date.now()-primary.at < 150000 &&
                primary.wheels.filter(w=>w.position!=='SPARE_TYRE'&&w.pressureBar!==null&&w.temperatureC!==null).length===4;
            if (complete || Date.now()-lastVehicleRead.tyres < 120000) return;
            lastVehicleRead.tyres=Date.now();
            const wheels=[];
            for (const wheel of VUDS.RDC) {
                const key='UDS.'+wheel.did.toString(16).toUpperCase();
                const value=await readVehicleMeasure(key,transport=>VUDS.readWheel(transport,wheel));
                if (value !== undefined) wheels.push(value);
                // Absence of one wheel is not proof that the other wheels are unavailable.
                // Let the native transport finish before the next request.
                await pause(180);
            }
            if (wheels.length) { faults.setRdcTyres(wheels); flush(true); }
        }
        let fallbackRunning=false;
        const pollVehicleFallback=async ()=>{
            if (fallbackRunning) return;
            fallbackRunning=true;
            try { await readVehicleFallback(); }
            catch (e) { log.warn('Vehicle measurements: '+e); }
            finally { fallbackRunning=false; }
        };
        setTimeout(() => { pollVehicleFallback(); setInterval(pollVehicleFallback,60000); }, 65000);
        const mileageSources=new VUDS.MileageSources();
        let mileageRunning=false,lastMileageAttempt=0,historyProbed=false;
        function resetMileageSources() {
            mileageSources.reset();lastMileageAttempt=0;historyProbed=false;
        }
        async function queryMileage(definition,history) {
            const key='UDS.'+definition.did.toString(16).toUpperCase();
            snap.stage(key,'getter','pending');
            let result;
            try { await withDiag('vehicle',key,async()=>{result=await VUDS.readMileage(diag,definition);}); }
            catch (e) { result={reason:diag&&diag.error?'diagnostic_provider_unavailable':'transport_or_queue'}; }
            const ok=result.value!==undefined||result.historical===true;
            snap.stage(key,'getter',ok?'ok':'failed');
            snap.stage(key,'decodeReason',result.reason||null);
            snap.stage(key,'odometer',Object.assign({
                ecu:definition.ecu,did:definition.did,expectedLength:definition.length,
                request:[0x22,definition.did>>8,definition.did&0xFF],
                at:new Date().toISOString(),historical:history===true,
            },result.detail,history?{}:mileageSources.record(definition,result)));
            snap.available(key,ok,result.reason);
            if (result.detail&&result.detail.responseLength!==undefined) sample(key,null,ok?1:null);
            else flush();
            return result;
        }
        async function pollMileage() {
            if (mileageRunning||snap.mileage(false)||Date.now()-lastMileageAttempt<3*60000) return;
            mileageRunning=true;lastMileageAttempt=Date.now();
            try {
                for (const definition of mileageSources.candidates()) {
                    const result=await queryMileage(definition,false);
                    if (result.value!==undefined) {
                        snap.diagnosticMileage(result.value,definition);flush(true);return;
                    }
                }
                if (!historyProbed) {
                    historyProbed=true;
                    for (const definition of VUDS.MILEAGE_HISTORY) await queryMileage(definition,true);
                }
            } catch (e) { log.warn('Mileage diagnostics: '+e); }
            finally { mileageRunning=false; }
        }
        setTimeout(()=>{pollMileage();setInterval(pollMileage,60000);},22000);
        setTimeout(() => readFaultMemory('start'), DTC_AUTO_AFTER_MS);
        setTimeout(() => { readDpf(); setInterval(readDpf, DPF_PRIMARY_MS); }, 45 * 1000);

        // The companion agent asks for a fresh fault-memory read by dropping a request file here.
        setInterval(() => {
            let req;
            try { req = JSON.parse(fs.readFileSync(path.join(dataDir, REQUEST_FILE), 'utf8')); } catch (e) { return; }
            if (!req || typeof req.id !== 'string' || req.id === lastRequest || req.type !== 'faultMemory') return;
            if (!Number.isFinite(Date.parse(req.at)) || Math.abs(Date.parse(req.at) - Date.now()) > 90000) return;
            lastRequest = req.id;
            readFaultMemory(req.id.slice(0, 64));
        }, 3000);

        ui.onClick('BTN_PAGE', () => { page = (page + 1) % 4; });
        ui.onClick('BTN_REFRESH', () => { readHistory('button'); readFaultMemory('button'); resetMileageSources();pollMileage(); });
        if (typeof ctx.onTab === 'function') ctx.onTab((i) => { if (i >= 0 && i < 4) page = i; });

        const label = (cv, t, x, y, size, colour, opt) => cv.text(ascii(t), x, y, size, colour || C.text, Object.assign({ literal: true }, opt || {}));
        const card = (cv, x, w, title) => { cv.roundRect(x, 112, w, 350, 17, C.card); label(cv, title, x + 30, 158, 24, C.dim); };
        function overview(cv) {
            const doc = snap.document(), m = doc.mileage;
            card(cv, 43, 520, 'MILEAGE');
            label(cv, m ? km(m.km) : '--', 73, 240, 52, C.text, { font: 'bold' });
            label(cv, m ? (m.valid ? 'from ' : 'last known: ') + m.source : 'no value from the car yet', 73, 290, 20, C.dim);
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
            if (!f.checkControl.active.length) label(cv, f.checkControl.listAt?'No active message.':'Complete list not read.', 73, 220, 24, C.dim);
            f.checkControl.active.slice(0, 6).forEach((c, i) => label(cv, (c.text || 'Message ' + c.id).slice(0, 52), 73, 210 + i * 44, 23, C.warn));
            card(cv, 973, 584, 'FAULT MEMORY');
            const d = f.faultMemory;
            if (queueState && (queueState.active==='fault'||queueState.waiting.indexOf('fault')!==-1)) {
                label(cv,queueState.active==='fault'?'Reading fault memory ...':'Waiting for diagnostic transport ...',1003,220,22,C.dim);
            } else if (!d) label(cv, 'Read after start.', 1003, 220, 24, C.dim);
            else if (d.error) {
                label(cv, 'Last scan failed', 1003, 220, 24, C.over);
                if(previousFaultScan)label(cv,'Previous scan: '+previousFaultScan.dtcs.length+' codes',1003,285,22,C.dim);
            }
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
            if (f.tyres) {
                const stale=Date.now()-Date.parse(f.tyres.at)>180000;
                label(cv, f.tyres.source+(stale?' (last known)':''), 73, 438, 18, C.dim);
            }
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
