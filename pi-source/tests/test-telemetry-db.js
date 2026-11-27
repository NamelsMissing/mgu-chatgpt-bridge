'use strict';
// Pi telemetry database: dedup, validation, trip summaries, recovery, series, retention, limits, schema guard.
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const telemetry=require('../telemetry');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'telemetry-db-'));
const db=telemetry.store(path.join(dir,'vehicle-telemetry.sqlite'));
const cfg=telemetry.settings();
const V='vehicle-a';
const T0=Date.UTC(2026,9,25,0,50,0); // across the end of summer time in Germany (01:00 UTC)

// A 20 minute trip at a steady 60 km/h with 2 s buckets, an idle minute at both ends.
function packet(id,rows,events,extra){return {schema:1,packetId:id,bootId:'aaaaaaaa',seq:1,createdAt:new Date(T0).toISOString(),clockPlausible:true,rows,events,...extra};}
const rows=[],start=T0,end=T0+20*60000;
for(let t=start;t<end;t+=2000){
  const moving=t>=start+60000&&t<end-60000;
  rows.push(['speed',t,2000,moving?60:0,moving?60:0,moving?60:0,moving?60:0,4]);
  rows.push(['rpm',t,2000,moving?1800:780,moving?1800:780,moving?1800:780,moving?1800:780,4]);
}
for(let t=start,c=20,o=15;t<end;t+=10000,c=Math.min(90,c+1),o=Math.min(100,o+1))rows.push(['coolant',t,10000,c,c,c,c,1],['oil',t,10000,o,o,o,o,1]);
const tripId='t'+start.toString(36)+'-abcdef';

(async()=>{
  // Ingest, dedup and validation.
  let r=await db.ingest(V,[packet('aaaaaaaa-1-'+T0,rows.slice(0,200),[{type:'trip_start',trip:tripId,at:start,odo:1000,reason:'speed'}])],cfg);
  assert.deepEqual(r.stored,['aaaaaaaa-1-'+T0]);assert.equal(r.rejected,0);
  r=await db.ingest(V,[packet('aaaaaaaa-1-'+T0,rows.slice(0,200),[])],cfg);
  assert.deepEqual(r.duplicate,['aaaaaaaa-1-'+T0],'a packet sent twice is stored once');
  const bad=[['speed',start,2000,999,999,999,999,1],['nope',start,2000,1,1,1,1,1],['speed',Date.now()+3600000,2000,50,50,50,50,1],
    ['speed',start,-5,50,50,50,50,1],['speed',start,2000,50,60,40,50,1],['speed',start,2000,'50',50,50,50,1],['speed',start,2000,50,50,50,50]];
  r=await db.ingest(V,[packet('aaaaaaaa-2-'+(T0+1),rows.slice(200).concat(bad),[{type:'trip_end',trip:tripId,at:end,odo:1018,reason:'parked',startAt:start,startOdo:1000}])],cfg);
  assert.equal(r.rejected,bad.length,'out of range, unknown signal, future, negative duration, min>max, strings, short rows');
  assert.deepEqual(r.closed,[tripId]);
  r=await db.ingest(V,[packet('aaaaaaaa-3-'+(T0+2),[['speed',start,2000,50,50,50,50,1]],[],{clockPlausible:false})],cfg);
  assert.equal(r.rejected,1,'implausible MGU clock');

  // Summary against hand-computed values.
  const {trip}=await db.trip(V,tripId,cfg);
  const s=trip.summary;
  assert.equal(trip.status,'closed');assert.equal(trip.start_km,1000);assert.equal(trip.end_km,1018);
  assert.equal(s.durationMs,20*60000,'20 min across the DST change: stored in UTC, no shift');
  assert.equal(s.distanceSpeedKm,18);assert.equal(s.distanceKm,18);assert.equal(s.distanceSource,'speed','18 km < 20 km: integrated speed wins with full coverage');
  assert.equal(s.movingMs,18*60000);assert.equal(s.standstillMs,2*60000);
  assert.equal(s.engineMs,20*60000);assert.equal(s.idleMs,2*60000);
  assert.equal(s.avgSpeedMovingKmh,60);assert.equal(s.avgSpeedKmh,54);assert.equal(s.maxSpeedKmh,60);assert.equal(s.maxRpm,1800);
  assert.equal(s.coolant.start,20);assert.equal(s.coolant.max,90);
  assert.equal(s.oil.max,100);assert.equal(s.oil.reached.ms,65*10000,'oil 15 -> 80 °C in 65 steps of 10 s');
  assert.equal(s.oil.reached.km,Math.round((650000-60000)/3600000*60*100)/100);
  assert.equal(s.coverage.speed,1);assert.equal(s.quality,'good');
  assert.equal(s.fuel.available,false,'no consumption from unconfirmed tank units');
  assert.equal(s.exteriorRaw,null);

  // Name, category, list.
  assert.equal((await db.update(V,tripId,'Arbeitsweg Montag','Arbeitsweg')).updated,true);
  let list=(await db.trips(V,cfg,{limit:10})).trips;
  assert.equal(list.length,1);assert.equal(list[0].name,'Arbeitsweg Montag');assert.equal(list[0].summary.distanceKm,18);
  assert.equal((await db.trips('other-vehicle',cfg,{})).trips.length,0,'vehicles stay separate');

  // A trip whose start packet was lost is recovered from the end event.
  await db.ingest(V,[packet('aaaaaaaa-4-'+(T0+3),[],[{type:'trip_end',trip:'tzz-000001',at:end+3600000,odo:1030,reason:'idle_timeout',startAt:end+1800000,startOdo:1020}])],cfg);
  const lost=(await db.trip(V,'tzz-000001',cfg)).trip;
  assert.equal(lost.partial,1);assert.equal(lost.start_ts,end+1800000);assert.equal(lost.summary.distanceKm,10);assert.equal(lost.summary.distanceSource,'odometer');
  assert.equal(lost.summary.quality,'poor');

  // Series: full resolution and downsampled with kept extremes.
  let series=await db.series(V,'speed',start,end,5000);
  assert.equal(series.points.length,600);
  series=await db.series(V,'speed',start,end,50);
  assert.ok(series.points.length<=50);
  assert.equal(Math.max(...series.points.map(p=>p[4])),60);assert.equal(Math.min(...series.points.map(p=>p[3])),0,'min and max survive downsampling');

  // Retention by age and size limit; trips stay.
  const stats=await db.stats(V);
  assert.equal(stats.samples,rows.length);assert.equal(stats.trips,2);
  assert.ok(stats.signals.some(x=>x.id==='exteriorRaw'&&x.verification==='unverified'));
  let m=await db.maintain(V,{...cfg,rawDays:7});
  assert.equal(m.removedByAge,rows.length,'samples older than 7 days removed');
  assert.equal((await db.stats(V)).trips,2,'trip summaries are kept');
  assert.equal((await db.trip(V,tripId,cfg)).trip.summary.distanceKm,18,'stored summary survives raw-data removal');
  const now=Date.now(),bulk=[];
  for(let i=0;i<60000;i++)bulk.push(['rpm',now-3600000+i*50,50,1000,1000,1000,1000,1]);
  await db.ingest(V,[packet('aaaaaaaa-5-'+now,bulk,[])],cfg);
  const before=db.size();
  m=await db.maintain(V,{...cfg,limitMb:1});
  assert.ok(m.removedByLimit>0,'size limit removes the oldest samples');
  assert.ok(db.size()<before,'database file shrinks: '+before+' -> '+db.size());

  // Delete one trip and reset the vehicle.
  assert.equal((await db.remove(V,'tzz-000001')).deleted,true);
  assert.equal((await db.trip(V,'tzz-000001',cfg)).trip,null);
  await db.reset(V);
  assert.equal((await db.stats(V)).vehicleTrips,0);

  // Schema guard: a database from a newer version is not touched.
  execFileSync('python3',['-c','import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);d.execute("UPDATE meta SET value=\'9\' WHERE key=\'schema\'");d.commit()',db.file]);
  await assert.rejects(db.stats(V),/neueren Version/);

  // Settings validation.
  assert.throws(()=>telemetry.settings({},{rawDays:1}),/rawDays/);
  assert.throws(()=>telemetry.settings({},{enabled:'yes'}),/enabled/);
  assert.throws(()=>telemetry.settings({},{other:1}),/Unbekannte/);
  assert.equal(telemetry.settings({rawDays:90}).rawDays,90);
  console.log('Pi telemetry database: dedup, validation, summaries (DST), recovery, series, retention, size limit, reset and schema guard passed.');
})().catch(e=>{console.error(e);process.exit(1);});
