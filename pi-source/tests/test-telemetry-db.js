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
  let series=(await db.series(V,'speed',start,end,5000)).series.speed;
  assert.equal(series.points.length,600);assert.equal(series.source,'raw');
  series=(await db.series(V,['speed','rpm'],start,end,50)).series;
  assert.ok(series.speed.points.length<=50&&series.rpm.points.length<=50);
  assert.equal(Math.max(...series.speed.points.map(p=>p[4])),60);assert.equal(Math.min(...series.speed.points.map(p=>p[3])),0,'min and max survive downsampling');
  assert.equal(s.version,2);
  assert.deepEqual(s.speedBandsMs,[0,0,18*60000,0,0],'60 km/h is the 60-100 band');

  // Overview for the statistics page.
  const ov=await db.overview(V,cfg,start-1,end+1);
  assert.equal(ov.trips.length,1);assert.equal(ov.trips[0].distanceKm,18);assert.equal(ov.trips[0].oilMax,100);
  assert.deepEqual(ov.trips[0].speedBandsMs,[0,0,18*60000,0,0]);

  // On-change values continue across a silent stop (Vehicle Data before 0.2.14 sent nothing while
  // the speed stayed 0). A 4 min stop without rows is covered, a 15 min hole is not.
  const T1=T0+86400000,gapTrip='t'+T1.toString(36)+'-aaaaaa',gr=[];
  for(let t=T1;t<T1+120000;t+=2000)gr.push(['speed',t,2000,t<T1+60000?50:0,t<T1+60000?50:0,t<T1+60000?50:0,t<T1+60000?50:0,1]);
  for(let t=T1+360000;t<T1+420000;t+=2000)gr.push(['speed',t,2000,50,50,50,50,1]);
  await db.ingest(V,[packet('aaaaaaaa-9-'+T1,gr,[{type:'trip_start',trip:gapTrip,at:T1,odo:2000,reason:'speed'},{type:'trip_end',trip:gapTrip,at:T1+420000,odo:2002,reason:'parked'}])],cfg);
  let gs=(await db.trip(V,gapTrip,cfg)).trip.summary;
  assert.equal(gs.coverage.speed,1,'4 min stop continued');assert.equal(gs.filledMs.speed,240000);
  assert.equal(gs.movingMs,120000);assert.equal(gs.standstillMs,300000);
  const filledSeries=(await db.series(V,'speed',T1,T1+420000,5000,true)).series.speed.points;
  assert.ok(filledSeries.some(p=>p[0]===T1+120000&&p[1]===240000&&p[2]===0),'charts continue the 0 as well');
  const gapTrip2='t'+(T1+3600000).toString(36)+'-bbbbbb',gr2=[];
  for(let t=T1+3600000;t<T1+3660000;t+=2000)gr2.push(['speed',t,2000,0,0,0,0,1]);
  for(let t=T1+4560000;t<T1+4620000;t+=2000)gr2.push(['speed',t,2000,30,30,30,30,1]);
  await db.ingest(V,[packet('aaaaaaaa-10-'+T1,gr2,[{type:'trip_start',trip:gapTrip2,at:T1+3600000,reason:'speed'},{type:'trip_end',trip:gapTrip2,at:T1+4620000,reason:'parked'}])],cfg);
  gs=(await db.trip(V,gapTrip2,cfg)).trip.summary;
  assert.ok(gs.coverage.speed<0.2,'a 15 min hole stays a hole: '+gs.coverage.speed);

  // Retention by age and size limit; trips stay.
  const stats=await db.stats(V);
  assert.equal(stats.samples,rows.length+gr.length+gr2.length);assert.equal(stats.trips,4);
  assert.ok(stats.signals.some(x=>x.id==='exteriorRaw'&&x.verification==='unverified'));
  let m=await db.maintain(V,{...cfg,rawDays:7});
  assert.equal(m.removedByAge,rows.length+gr.length+gr2.length,'samples older than 7 days removed');
  assert.equal((await db.stats(V)).trips,4,'trip summaries are kept');
  // Minute aggregates outlive the raw data, so old trips still have curves.
  const old=(await db.series(V,['oil','speed'],start,end,5000)).series;
  assert.equal(old.oil.source,'minute');assert.equal(old.oil.points.length,20);
  assert.equal(Math.max(...old.oil.points.map(p=>p[4])),100,'minute max kept');
  assert.equal(old.speed.points[5][1],60000);assert.equal(old.speed.points[5][2],60,'time-weighted minute mean');
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

  // Migration 1 -> 2: a database written by Pi 0.11.0 (no minute table, schema 1) gets minute
  // aggregates from the raw samples it still has.
  const legacy=telemetry.store(path.join(dir,'legacy.sqlite'));
  await legacy.ingest(V,[packet('aaaaaaaa-1-'+T0,rows.slice(0,300),[])],cfg);
  execFileSync('python3',['-c','import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);d.execute("DROP TABLE samples_minute");d.execute("UPDATE meta SET value=\'1\' WHERE key=\'schema\'");d.commit()',legacy.file]);
  const upgradedMinutes=execFileSync('python3',['-c','import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute("SELECT count(*) FROM sqlite_master WHERE name=\'samples_minute\'").fetchone()[0])',legacy.file]).toString().trim();
  assert.equal(upgradedMinutes,'0');
  await legacy.stats(V);
  const migrated=execFileSync('python3',['-c','import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);print(d.execute("SELECT value FROM meta WHERE key=\'schema\'").fetchone()[0], d.execute("SELECT count(*), sum(covered_ms) FROM samples_minute WHERE signal_id=\'speed\'").fetchone())',legacy.file]).toString().trim();
  assert.match(migrated,/^2 \(\d+, \d+\)$/,'schema 2 with minute rows: '+migrated);

  // Settings validation.
  assert.throws(()=>telemetry.settings({},{rawDays:1}),/rawDays/);
  assert.throws(()=>telemetry.settings({},{enabled:'yes'}),/enabled/);
  assert.throws(()=>telemetry.settings({},{other:1}),/Unbekannte/);
  assert.equal(telemetry.settings({rawDays:90}).rawDays,90);
  console.log('Pi telemetry database: dedup, validation, summaries (DST), recovery, series, retention, size limit, reset and schema guard passed.');
})().catch(e=>{console.error(e);process.exit(1);});
