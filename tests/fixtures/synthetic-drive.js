'use strict';
// Synthetic drive for tests only: cold start, town with start-stop, country road, motorway,
// parking. Produces raw SOME/IP structs as the head unit delivers them (raw integers, enum
// names), so the decoder, the aggregation and the trip detection run on realistic input.
// Never used in the production path.

const RAW = {
    speed: (kmh) => ({ speedVehicleCentreOfGravity: Math.round(kmh / 0.015625) }),
    rpm: (n) => ({ actualValueRPMEngineCrankshaft: Math.round(n / 0.25) }),
    temps: (coolant, oil) => ({ temperatureEngineDrive: Math.round(coolant + 48), temperatureEngineOilDrive: Math.round(oil + 48) }),
    accelLong: (ms2) => ({ longitudinalAccelerationCentreOfGravity: Math.round((ms2 + 65) / 0.002) }),
    accelLat: (ms2) => ({ lateralAccelerationCentreOfGravity: Math.round((ms2 + 65) / 0.002) }),
    torque: (nm) => ({ actualValueTorqueCrankshaft: Math.round((nm + 1023.5) / 0.5) }),
    tank: (odo) => ({ fluidLevelFuelTank: 40, fluidLevelFuelTankLeftHand: 0, fluidLevelFuelTankRightHand: 0,
        statusFluidLevelFuelTankSpare: 'NICHT_AKTIV', range: 640, mileageKilometre: odo }),
    condition: (name) => ({ cRCConditionVehicle: 0, aliveConditionVehicle: 0, controlBasePartialNetworks: 'KOM_FAHREN',
        controlFunctionalPartialNetworks: 0, statusConditionVehicle: name, qualifierStatusConditionVehicle: 'SIGNALWERT_GUELTIG', dummy: 0 }),
    sailing: (name) => ({ statusSailingDrive: name }),
    exterior: (raw) => ({ temperatureExterior: raw }),
};
const IF = {
    speed: ['de.bmw.infotainment.vehicle.Vehicle2', 'statusCarSpeed2'],
    rpm: ['de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2'],
    temps: ['de.bmw.infotainment.vehicle.CDS', 'statusEngineTemperature'],
    accelLong: ['de.bmw.infotainment.vehicle.CDS2', 'statusLongitudinalAccelerationMassCenter'],
    accelLat: ['de.bmw.infotainment.vehicle.CDS2', 'statusLateralAccelerationMassCenter'],
    torque: ['de.bmw.infotainment.drivingexcitement.FES', 'statusActualValueTorque2'],
    tank: ['de.bmw.infotainment.KombiIF', 'statusRangeTankStatus'],
    condition: ['de.bmw.infrastructure.VehicleCondition', 'VehicleCondition'],
    sailing: ['de.bmw.infotainment.drivingexcitement.Efficiencytainment', 'statusPowerTrainSailing'],
    exterior: ['de.bmw.infrastructure.EnvironmentalInformation', 'ExteriorTemperature'],
};

/** Speed profile in km/h for second s of the drive (0 ... 1500 s, then parked). */
function profile(s) {
    if (s < 60) return 0;                                   // cold start, warm-up idle
    if (s < 420) {                                          // town: 40 s driving, 20 s at a light
        const p = (s - 60) % 60;
        return p < 10 ? p * 4.5 : p < 35 ? 45 : p < 40 ? (40 - p) * 9 : 0;
    }
    if (s < 900) return Math.min(90, (s - 420) * 3);        // country road
    if (s < 1400) return Math.min(128, 90 + (s - 900) * 0.5); // motorway
    if (s < 1440) return Math.max(0, 128 - (s - 1400) * 3.2); // off the motorway, stop
    return 0;                                               // parked
}

/**
 * Feed the drive into sink(iface, field, raw, t). start: ms UTC of second 0.
 * Returns facts the tests compare against (distance, max speed, start/end times).
 */
function drive(start, sink, opts) {
    opts = opts || {};
    const hz = opts.hz || 5;
    let distanceKm = 0, odo = opts.odo || 143350, odoFrac = 0, coolant = 8, oil = 6, vmax = 0;
    let lastTemps = null, startStop = false;
    const emit = (key, raw, t) => sink(IF[key][0], IF[key][1], raw, t);
    emit('condition', RAW.condition('WOHNEN'), start - 20000);
    emit('exterior', RAW.exterior(96), start - 19000);
    emit('condition', RAW.condition('FAHRBEREITSCHAFT_HERSTELLEN'), start);
    emit('condition', RAW.condition('FAHREN'), start + 1500);
    emit('tank', RAW.tank(odo), start + 2000);
    for (let i = 0; i <= 1440 * hz; i++) {
        const s = i / hz, t = start + Math.round(s * 1000), v = profile(s);
        const dt = 1 / hz;
        distanceKm += v * dt / 3600;
        vmax = Math.max(vmax, v);
        // Start-stop: the engine stops at town lights after warm-up; the car stays ready (FAHREN).
        const stop = s > 120 && s < 420 && v === 0;
        if (stop !== startStop) { startStop = stop; }
        const rpm = s >= 1440 ? 0 : stop ? 0 : v < 1 ? 780 : 800 + v * 18;
        emit('speed', RAW.speed(v), t);
        emit('rpm', RAW.rpm(rpm), t);
        emit('torque', RAW.torque(stop ? 0 : 40 + v), t);
        emit('accelLong', RAW.accelLong((profile(s + dt) - v) / 3.6 / dt), t);
        emit('accelLat', RAW.accelLat(0.3), t);
        if (s > 600 && s < 650) emit('sailing', RAW.sailing(Math.floor(s) % 20 < 10 ? 'SEGELN_AKTIV' : 'SEGELN_MOEGLICH_PASSIV'), t);
        if (Number.isInteger(s) && s % 15 === 0) {
            coolant = Math.min(92, coolant + (s < 900 ? 1.3 : 0.4));
            oil = Math.min(103, oil + (s < 900 ? 1.0 : 0.6));
            const temps = [Math.round(coolant), Math.round(oil)];
            if (!lastTemps || temps[0] !== lastTemps[0] || temps[1] !== lastTemps[1]) emit('temps', RAW.temps(temps[0], temps[1]), t);
            lastTemps = temps;
        }
        odoFrac += v * dt / 3600;
        if (odoFrac >= 1) { odoFrac -= 1; odo += 1; emit('tank', RAW.tank(odo), t); }
    }
    const end = start + 1440 * 1000;
    emit('condition', RAW.condition('FAHRBEREITSCHAFT_BEENDEN'), end + 2000);
    emit('condition', RAW.condition('PARKEN_BN_IO'), end + 8000);
    return { distanceKm, vmax, start, end, odoEnd: odo, maxCoolant: Math.round(coolant), maxOil: Math.round(oil) };
}

module.exports = { drive, profile, RAW, IF };
