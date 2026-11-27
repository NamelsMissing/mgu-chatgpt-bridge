'use strict';
// Vehicle telemetry on the Pi: a separate SQLite database (vehicle-telemetry.sqlite) for the
// packets Vehicle Data collects on the MGU. Same approach as service-reference.js: Python's
// sqlite3 from the standard library, no npm dependency. Every call runs one transaction.
//
// Samples are stored with their measurement time (ms UTC), never the receive time. Packets are
// deduplicated by packet id, so a packet sent twice (no acknowledgement reached the MGU) is
// stored once. Trip summaries are computed here from the stored samples.
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const CATALOG=require('./telemetry-catalog.json');

const DEFAULTS=Object.freeze({enabled:true,idleEndMin:10,bufferMb:20,rawDays:30,limitMb:500,oilThresholdC:80,coolantThresholdC:80});
const LIMITS={idleEndMin:[2,120],bufferMb:[2,200],rawDays:[7,365],limitMb:[50,20000],oilThresholdC:[30,130],coolantThresholdC:[30,120]};
const CATEGORIES=['Arbeitsweg','Privat','Langstrecke','Werkstatt','Sonstige'];

function settings(stored,patch){
  const out={...DEFAULTS,...(stored&&typeof stored==='object'?stored:{})};
  for(const [k,v] of Object.entries(patch||{})){
    if(k==='enabled'){if(typeof v!=='boolean')throw Error('enabled muss true oder false sein');out.enabled=v;continue;}
    if(!LIMITS[k])throw Error('Unbekannte Einstellung: '+k);
    const [lo,hi]=LIMITS[k];
    if(!Number.isInteger(v)||v<lo||v>hi)throw Error(k+' muss eine ganze Zahl von '+lo+' bis '+hi+' sein');
    out[k]=v;
  }
  return out;
}

const python=String.raw`
import json, math, os, sqlite3, sys, time
path, op = sys.argv[1], sys.argv[2]
req = json.load(sys.stdin)
new = not os.path.exists(path)
db = sqlite3.connect(path, timeout=30)
if new:
    os.chmod(path, 0o600)
    db.execute("PRAGMA auto_vacuum=INCREMENTAL")
db.execute("PRAGMA journal_mode=WAL")
db.execute("PRAGMA foreign_keys=ON")
SCHEMA = 1
db.executescript("""
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vehicles (id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS signals (id TEXT PRIMARY KEY, name_de TEXT NOT NULL, name_en TEXT NOT NULL, category TEXT NOT NULL,
  unit TEXT NOT NULL, kind TEXT NOT NULL, verification TEXT NOT NULL, definition TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS packets (packet_id TEXT PRIMARY KEY, vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  received_at INTEGER NOT NULL, created_at TEXT, boot_id TEXT, seq INTEGER, rows INTEGER NOT NULL, events INTEGER NOT NULL,
  rejected INTEGER NOT NULL, truncated INTEGER NOT NULL, clock_plausible INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS samples (vehicle_id INTEGER NOT NULL REFERENCES vehicles(id), signal_id TEXT NOT NULL REFERENCES signals(id),
  ts INTEGER NOT NULL, duration_ms INTEGER NOT NULL, value REAL NOT NULL, min REAL NOT NULL, max REAL NOT NULL, last REAL NOT NULL,
  count INTEGER NOT NULL, source TEXT NOT NULL, packet_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS samples_signal_time ON samples(vehicle_id, signal_id, ts);
CREATE INDEX IF NOT EXISTS samples_time ON samples(vehicle_id, ts);
CREATE TABLE IF NOT EXISTS trips (id TEXT PRIMARY KEY, vehicle_id INTEGER NOT NULL REFERENCES vehicles(id), start_ts INTEGER NOT NULL,
  end_ts INTEGER, start_km INTEGER, end_km INTEGER, start_reason TEXT, end_reason TEXT, status TEXT NOT NULL,
  name TEXT, category TEXT, summary TEXT, summary_at INTEGER, partial INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS trips_time ON trips(vehicle_id, start_ts);
CREATE TABLE IF NOT EXISTS events (packet_id TEXT NOT NULL, idx INTEGER NOT NULL, vehicle_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  type TEXT NOT NULL, trip_id TEXT, data TEXT NOT NULL, PRIMARY KEY (packet_id, idx));
""")
db.execute("INSERT OR IGNORE INTO meta(key,value) VALUES('schema',?)", (str(SCHEMA),))
if int(db.execute("SELECT value FROM meta WHERE key='schema'").fetchone()[0]) > SCHEMA:
    raise SystemExit("Telemetrie-Datenbank stammt aus einer neueren Version")

def vehicle(key, create=True):
    row = db.execute("SELECT id FROM vehicles WHERE key=?", (key,)).fetchone()
    if row: return row[0]
    if not create: return None
    return db.execute("INSERT INTO vehicles(key, created_at) VALUES(?,?)", (key, int(time.time()*1000))).lastrowid

def sync_signals(catalog):
    for s in catalog["signals"]:
        db.execute("""INSERT INTO signals(id,name_de,name_en,category,unit,kind,verification,definition) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET name_de=excluded.name_de,name_en=excluded.name_en,category=excluded.category,unit=excluded.unit,
          kind=excluded.kind,verification=excluded.verification,definition=excluded.definition""",
          (s["id"], s["nameDe"], s["nameEn"], s["category"], s["unit"], s["kind"], s["verification"], json.dumps(s, sort_keys=True)))

def finite(x): return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)

def summarize(vid, trip, cfg):
    start, end = trip["start_ts"], trip["end_ts"] or int(time.time()*1000)
    total = max(end - start, 0)
    by = {}
    for sid, ts, dur, v, lo, hi, last in db.execute("""SELECT signal_id, ts, duration_ms, value, min, max, last FROM samples
        WHERE vehicle_id=? AND ts>=? AND ts<=? ORDER BY ts""", (vid, start - 2000, end)):
        by.setdefault(sid, []).append((ts, dur, v, lo, hi, last))
    def covered(sid): return sum(r[1] for r in by.get(sid, []))
    speed = by.get("speed", [])
    speed_at = {r[0]: r for r in speed}
    dist_speed = sum(r[2] * r[1] for r in speed) / 3600000.0 if speed else None
    odo = None
    if trip["start_km"] is not None and trip["end_km"] is not None and 0 <= trip["end_km"] - trip["start_km"] < 2000:
        odo = trip["end_km"] - trip["start_km"]
    cover = {sid: (min(1.0, covered(sid) / total) if total else 0.0) for sid in ("speed", "rpm", "coolant", "oil", "torque")}
    if odo is not None and odo >= 20: distance, dsource = float(odo), "odometer"
    elif dist_speed is not None and cover["speed"] >= 0.8: distance, dsource = dist_speed, "speed"
    elif odo is not None: distance, dsource = float(odo), "odometer"
    elif dist_speed is not None: distance, dsource = dist_speed, "speed_incomplete"
    else: distance, dsource = None, None
    moving = sum(r[1] for r in speed if r[4] > 3)
    rpm = by.get("rpm", [])
    running = [r for r in rpm if r[2] > 300]
    engine = sum(r[1] for r in running)
    idle = sum(r[1] for r in running if r[0] in speed_at and speed_at[r[0]][4] <= 3)
    def first_reach(sid, thr):
        for r in by.get(sid, []):
            if r[4] >= thr:
                t = max(r[0], start)
                km = sum(s[2] * max(0, min(s[0] + s[1], t) - s[0]) for s in speed if s[0] < t) / 3600000.0
                return {"ms": t - start, "km": round(km, 2)}
        return None
    def temp(sid, thr):
        rows = by.get(sid, [])
        if not rows: return None
        return {"start": rows[0][2], "min": min(r[3] for r in rows), "max": max(r[4] for r in rows),
                "mean": round(sum(r[2] * r[1] for r in rows) / max(1, sum(r[1] for r in rows)), 1),
                "threshold": thr, "reached": first_reach(sid, thr)}
    def raw(sid):
        rows = by.get(sid, [])
        return {"first": rows[0][2], "last": rows[-1][5], "min": min(r[3] for r in rows), "max": max(r[4] for r in rows)} if rows else None
    h = lambda ms: ms / 3600000.0
    return {
        "version": 1, "open": trip["end_ts"] is None, "durationMs": total,
        "distanceKm": round(distance, 2) if distance is not None else None, "distanceSource": dsource,
        "distanceSpeedKm": round(dist_speed, 2) if dist_speed is not None else None, "distanceOdometerKm": odo,
        "movingMs": moving, "standstillMs": max(0, total - moving) if speed else None,
        "engineMs": engine if rpm else None, "idleMs": idle if rpm and speed else None,
        "avgSpeedMovingKmh": round(distance / h(moving), 1) if distance and moving else None,
        "avgSpeedKmh": round(distance / h(total), 1) if distance and total else None,
        "maxSpeedKmh": round(max(r[4] for r in speed), 1) if speed else None,
        "maxRpm": round(max(r[4] for r in rpm)) if rpm else None,
        "avgRpmRunning": round(sum(r[2] * r[1] for r in running) / engine) if engine else None,
        "maxTorqueNm": round(max(r[4] for r in by["torque"]), 1) if by.get("torque") else None,
        "coolant": temp("coolant", cfg["coolantThresholdC"]), "oil": temp("oil", cfg["oilThresholdC"]),
        "exteriorRaw": raw("exteriorRaw"), "fuelLevelRaw": raw("fuelLevelRaw"),
        "fuel": {"available": False, "reason": "Tankfüllstand noch nicht in Litern bestätigt"},
        "coverage": {k: round(v, 3) for k, v in cover.items()},
        "quality": "good" if cover["speed"] >= 0.9 and cover["rpm"] >= 0.8 else "partial" if cover["speed"] >= 0.5 else "poor",
    }

def trip_row(r):
    keys = ("id", "vehicle_id", "start_ts", "end_ts", "start_km", "end_km", "start_reason", "end_reason", "status", "name", "category", "summary", "summary_at", "partial")
    d = dict(zip(keys, r))
    d["summary"] = json.loads(d["summary"]) if d["summary"] else None
    return d
TRIP_COLS = "id, vehicle_id, start_ts, end_ts, start_km, end_km, start_reason, end_reason, status, name, category, summary, summary_at, partial"

def close(vid, tid, cfg):
    t = trip_row(db.execute("SELECT " + TRIP_COLS + " FROM trips WHERE id=? AND vehicle_id=?", (tid, vid)).fetchone())
    db.execute("UPDATE trips SET summary=?, summary_at=? WHERE id=?", (json.dumps(summarize(vid, t, cfg)), int(time.time()*1000), tid))

out = {}
with db:
    sync_signals(req["catalog"])
    cfg = req.get("settings") or {}
    if op == "ingest":
        vid = vehicle(req["vehicle"])
        known = {s["id"]: s for s in req["catalog"]["signals"]}
        now = int(time.time()*1000)
        stored, duplicate, rejected, closed = [], [], 0, set()
        for p in req["packets"]:
            pid = p.get("packetId")
            if not isinstance(pid, str) or len(pid) > 64: continue
            if db.execute("SELECT 1 FROM packets WHERE packet_id=?", (pid,)).fetchone():
                duplicate.append(pid); continue
            bad = 0
            plausible = 1 if p.get("clockPlausible") is True else 0
            for r in p.get("rows") or []:
                ok = isinstance(r, list) and len(r) == 8 and r[0] in known and all(finite(x) for x in r[1:8])
                if ok:
                    sid, ts, dur, v, lo, hi, last, n = r
                    s = known[sid]
                    ok = (plausible and 1735689600000 <= ts <= now + 600000 and 0 <= dur <= 3600000 and lo <= v + 1e-6 and v <= hi + 1e-6
                          and (s["kind"] == "enum" or (s["min"] - 1e-6 <= lo and hi <= s["max"] + 1e-6)))
                if not ok: bad += 1; continue
                db.execute("INSERT INTO samples VALUES(?,?,?,?,?,?,?,?,?,?,?)", (vid, sid, int(ts), int(dur), v, lo, hi, last, int(n), "someip", pid))
            events = p.get("events") or []
            for i, e in enumerate(events):
                if not isinstance(e, dict) or not isinstance(e.get("trip"), str) or not finite(e.get("at")) or len(e["trip"]) > 40: bad += 1; continue
                at, tid, odo = int(e["at"]), e["trip"], e.get("odo") if finite(e.get("odo")) else None
                db.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?)", (pid, i, vid, at, str(e.get("type"))[:20], tid, json.dumps(e)))
                row = db.execute("SELECT status FROM trips WHERE id=? AND vehicle_id=?", (tid, vid)).fetchone()
                if e.get("type") in ("trip_start", "trip_resume") and not row:
                    db.execute("INSERT INTO trips(id,vehicle_id,start_ts,start_km,start_reason,status,partial) VALUES(?,?,?,?,?,?,?)",
                               (tid, vid, at, odo, e.get("reason") or e["type"], "open", 0 if e["type"] == "trip_start" else 1))
                elif e.get("type") == "trip_end":
                    if not row:
                        st = int(e["startAt"]) if finite(e.get("startAt")) else at
                        so = e.get("startOdo") if finite(e.get("startOdo")) else None
                        db.execute("INSERT INTO trips(id,vehicle_id,start_ts,start_km,start_reason,status,partial) VALUES(?,?,?,?,?,?,1)",
                                   (tid, vid, st, so, "recovered", "open"))
                    db.execute("UPDATE trips SET end_ts=?, end_km=?, end_reason=?, status='closed' WHERE id=?", (at, odo, e.get("reason"), tid))
                    closed.add(tid)
            db.execute("INSERT INTO packets VALUES(?,?,?,?,?,?,?,?,?,?,?)", (pid, vid, now, p.get("createdAt"), p.get("bootId"), p.get("seq"),
                       len(p.get("rows") or []), len(events), bad, 1 if p.get("truncated") else 0, plausible))
            rejected += bad
            stored.append(pid)
        for tid in closed: close(vid, tid, cfg)
        out = {"stored": stored, "duplicate": duplicate, "rejected": rejected, "closed": sorted(closed)}
    elif op == "trips":
        vid = vehicle(req["vehicle"], False)
        rows = [] if vid is None else db.execute("SELECT " + TRIP_COLS + " FROM trips WHERE vehicle_id=? AND start_ts<? ORDER BY start_ts DESC LIMIT ?",
                                                 (vid, int(req.get("before") or 9e15), int(req.get("limit") or 50))).fetchall()
        out = {"trips": [trip_row(r) for r in rows]}
        for t in out["trips"]:
            if t["status"] == "open": t["summary"] = summarize(vid, t, cfg)
    elif op == "trip":
        vid = vehicle(req["vehicle"], False)
        r = vid and db.execute("SELECT " + TRIP_COLS + " FROM trips WHERE id=? AND vehicle_id=?", (req["id"], vid)).fetchone()
        if not r: out = {"trip": None}
        else:
            t = trip_row(r)
            if t["status"] == "open" or req.get("recompute"):
                t["summary"] = summarize(vid, t, cfg)
                if t["status"] != "open": db.execute("UPDATE trips SET summary=?, summary_at=? WHERE id=?", (json.dumps(t["summary"]), int(time.time()*1000), t["id"]))
            out = {"trip": t}
    elif op == "update":
        vid = vehicle(req["vehicle"], False)
        n = vid and db.execute("UPDATE trips SET name=?, category=? WHERE id=? AND vehicle_id=?", (req.get("name"), req.get("category"), req["id"], vid)).rowcount
        out = {"updated": bool(n)}
    elif op == "delete":
        vid = vehicle(req["vehicle"], False)
        r = vid and db.execute("SELECT start_ts, end_ts FROM trips WHERE id=? AND vehicle_id=?", (req["id"], vid)).fetchone()
        if r:
            removed = db.execute("DELETE FROM samples WHERE vehicle_id=? AND ts>=? AND ts<=?", (vid, r[0], r[1] or r[0])).rowcount
            db.execute("DELETE FROM events WHERE vehicle_id=? AND trip_id=?", (vid, req["id"]))
            db.execute("DELETE FROM trips WHERE id=?", (req["id"],))
            out = {"deleted": True, "samples": removed}
        else: out = {"deleted": False}
    elif op == "series":
        vid = vehicle(req["vehicle"], False)
        rows = [] if vid is None else db.execute("""SELECT ts, duration_ms, value, min, max FROM samples
            WHERE vehicle_id=? AND signal_id=? AND ts>=? AND ts<=? ORDER BY ts""", (vid, req["signal"], int(req["from"]), int(req["to"]))).fetchall()
        mx = int(req.get("max") or 2000)
        if len(rows) > mx:
            step, merged = math.ceil(len(rows) / mx), []
            for i in range(0, len(rows), step):
                chunk = rows[i:i+step]
                cov = sum(c[1] for c in chunk)
                merged.append((chunk[0][0], (chunk[-1][0] + chunk[-1][1]) - chunk[0][0], round(sum(c[2]*c[1] for c in chunk) / cov, 4) if cov else chunk[0][2],
                               min(c[3] for c in chunk), max(c[4] for c in chunk)))
            rows = merged
        out = {"signal": req["signal"], "points": [list(r) for r in rows]}
    elif op == "reset":
        vid = vehicle(req["vehicle"], False)
        if vid:
            for table in ("samples", "events", "trips", "packets"): db.execute("DELETE FROM " + table + " WHERE vehicle_id=?", (vid,))
        out = {"reset": True}
    elif op == "maintain":
        vid = vehicle(req["vehicle"], False)
        cutoff = int(time.time()*1000) - int(cfg["rawDays"]) * 86400000
        removed = db.execute("DELETE FROM samples WHERE ts<?", (cutoff,)).rowcount
        db.execute("DELETE FROM packets WHERE received_at<?", (cutoff,))
        out = {"removedByAge": removed, "removedByLimit": 0}
    elif op == "stats":
        vid = vehicle(req["vehicle"], False)
        q = lambda sql, *a: db.execute(sql, a).fetchone()[0]
        out = {"samples": q("SELECT count(*) FROM samples"), "trips": q("SELECT count(*) FROM trips"), "packets": q("SELECT count(*) FROM packets"),
               "oldestSample": q("SELECT min(ts) FROM samples"), "newestSample": q("SELECT max(ts) FROM samples"),
               "vehicleTrips": q("SELECT count(*) FROM trips WHERE vehicle_id=?", vid) if vid else 0,
               "signals": [dict(zip(("id","nameDe","nameEn","category","unit","kind","verification"), r)) for r in
                           db.execute("SELECT id,name_de,name_en,category,unit,kind,verification FROM signals ORDER BY category,id")]}
    else:
        raise SystemExit("unknown op " + op)
if op == "maintain":
    # Size limit: drop the oldest samples in steps of 10 %, trips and summaries stay.
    limit = int(cfg["limitMb"]) * 1024 * 1024
    def size(): return sum(os.path.getsize(path + x) for x in ("", "-wal") if os.path.exists(path + x))
    for _ in range(12):
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        if size() <= limit: break
        n = db.execute("SELECT count(*) FROM samples").fetchone()[0]
        if not n: break
        with db:
            cut = db.execute("SELECT ts FROM samples ORDER BY ts LIMIT 1 OFFSET ?", (max(1, n // 10) - 1,)).fetchone()[0]
            out["removedByLimit"] += db.execute("DELETE FROM samples WHERE ts<=?", (cut,)).rowcount
        db.execute("PRAGMA incremental_vacuum")
    db.execute("PRAGMA incremental_vacuum")
    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    db.execute("PRAGMA optimize")
print(json.dumps(out))
`;

function store(file){
  let chain=Promise.resolve();
  function run(op,request){
    const job=()=>new Promise((resolve,reject)=>{
      const child=spawn('python3',['-I','-c',python,file,op],{stdio:['pipe','pipe','pipe']});
      let out='',err='';
      const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
      child.stdout.on('data',d=>{out+=d;});
      child.stderr.on('data',d=>{if(err.length<4000)err+=d;});
      child.on('error',e=>{clearTimeout(timer);reject(e);});
      child.on('close',code=>{
        clearTimeout(timer);
        if(code!==0)return reject(Error('Telemetrie-Datenbank: '+(err.trim().split('\n').pop()||'Exit '+code).slice(0,300)));
        try{resolve(JSON.parse(out));}catch(e){reject(Error('Telemetrie-Datenbank: ungültige Antwort'));}
      });
      child.stdin.end(JSON.stringify({catalog:CATALOG,...request}));
    });
    // One writer at a time; a failed call does not block the next.
    const result=chain.then(job,job);
    chain=result.catch(()=>{});
    return result;
  }
  const size=()=>['','-wal','-shm'].reduce((s,x)=>{try{return s+fs.statSync(file+x).size;}catch(e){return s;}},0);
  return {
    run,size,file,
    ingest:(vehicle,packets,cfg)=>run('ingest',{vehicle,packets,settings:cfg}),
    trips:(vehicle,cfg,opts)=>run('trips',{vehicle,settings:cfg,...opts}),
    trip:(vehicle,id,cfg,recompute)=>run('trip',{vehicle,id,settings:cfg,recompute:!!recompute}),
    update:(vehicle,id,name,category)=>run('update',{vehicle,id,name,category}),
    remove:(vehicle,id)=>run('delete',{vehicle,id}),
    series:(vehicle,signal,from,to,max)=>run('series',{vehicle,signal,from,to,max}),
    reset:(vehicle)=>run('reset',{vehicle}),
    maintain:(vehicle,cfg)=>run('maintain',{vehicle,settings:cfg}),
    stats:(vehicle)=>run('stats',{vehicle}),
  };
}

module.exports={store,settings,DEFAULTS,LIMITS,CATEGORIES,CATALOG};
