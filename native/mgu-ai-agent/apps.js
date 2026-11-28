'use strict';
// Installed OAP apps on the MGU: overview with error counts, and logs/error records per app.
// Kit apps write data/<app-id>.log (rotated to .log.1) with ISO time and level (ERROR, WARN,
// INFO, FATAL for crashes, SDK_ERROR/SDK_WARN for SDK problems) plus own diagnostics or report
// files. Files that look like credentials are listed but never returned.
// Compatible with Node 8.7 syntax.
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ERROR_LEVELS = /^(\S+)\s+(FATAL|ERROR|SDK_ERROR)\s/;
var WARN_LEVELS = /^(\S+)\s+(WARN|SDK_WARN)\s/;
var LOG_FILE = /\.log(\.\d+)?$/i;
var REPORT_FILE = /(diagnos|report|error|crash|fault|status|events|observation|inventory|recovery)[^/]*\.(json|txt|log)$/i;
var SECRET = /(auth|token|secret|passw|credential|cookie|private|\.key$|\.pem$|uplink|session)/i;
var TAIL_BYTES = 512 * 1024;

function readTail(file, bytes) {
  var fd = fs.openSync(file, 'r');
  try {
    var size = fs.fstatSync(fd).size, start = Math.max(0, size - bytes), len = size - start, buf = Buffer.alloc(len);
    var got = 0;
    while (got < len) { var n = fs.readSync(fd, buf, got, len - got, start + got); if (!n) break; got += n; }
    var text = buf.slice(0, got).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);   // drop the cut first line
    return { text: text, size: size, cut: start > 0 };
  } finally { fs.closeSync(fd); }
}
function lines(text) { return text.split('\n').filter(function (l) { return l.length; }); }

/** Running OAP processes: { 'oap_12': [{pid, rssMb}] } from /proc. */
function processes(root) {
  var out = {};
  var list;
  try { list = fs.readdirSync('/proc'); } catch (e) { return out; }
  list.forEach(function (pid) {
    if (!/^\d+$/.test(pid)) return;
    var cmd;
    try { cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' '); } catch (e) { return; }
    var m = cmd.indexOf(root + '/') >= 0 ? new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/(oap_\\d+)/').exec(cmd) : null;
    if (!m) return;
    var rss = null;
    try { var st = /VmRSS:\s+(\d+)/.exec(fs.readFileSync('/proc/' + pid + '/status', 'utf8')); if (st) rss = Math.round(Number(st[1]) / 1024); } catch (e) { /* gone */ }
    (out[m[1]] = out[m[1]] || []).push({ pid: Number(pid), rssMb: rss });
  });
  return out;
}

function appInfo(root, dir) {
  var base = path.join(root, dir), info = { dir: dir, path: base, id: null, name: null, version: null, dataDir: path.join(base, 'data') };
  try { var pkg = JSON.parse(fs.readFileSync(path.join(base, 'source', 'package.json'), 'utf8')); info.id = pkg.name || null; info.version = pkg.version || null; } catch (e) { /* not a kit app */ }
  try {
    var spec = JSON.parse(fs.readFileSync(path.join(base, 'source', 'javascript', 'app-spec.json'), 'utf8'));
    info.id = spec.id || info.id; info.name = spec.name || spec.title || null; info.version = spec.version || info.version;
  } catch (e) { /* older layout */ }
  return info;
}

function dataFiles(dataDir) {
  var names;
  try { names = fs.readdirSync(dataDir); } catch (e) { return []; }
  return names.map(function (n) {
    try {
      var st = fs.statSync(path.join(dataDir, n));
      if (!st.isFile()) return null;
      return { name: n, bytes: st.size, modified: st.mtime.toISOString(), log: LOG_FILE.test(n), report: REPORT_FILE.test(n) && !LOG_FILE.test(n), secret: SECRET.test(n) };
    } catch (e) { return null; }
  }).filter(Boolean).sort(function (a, b) { return a.name < b.name ? -1 : 1; });
}

/** Main log of the app: <id>.log, else the newest *.log. */
function mainLog(info, files) {
  var own = info.id && files.filter(function (f) { return f.name === info.id + '.log'; })[0];
  if (own) return own.name;
  var logs = files.filter(function (f) { return /\.log$/i.test(f.name); }).sort(function (a, b) { return a.modified < b.modified ? 1 : -1; });
  return logs.length ? logs[0].name : null;
}

function summary(dataDir, logName) {
  var s = { file: logName, errors: 0, warnings: 0, fatal: 0, lastError: null, lastLine: null, lastAt: null, exits: [] };
  if (!logName) return s;
  [logName + '.1', logName].forEach(function (n) {
    var f = path.join(dataDir, n), t;
    try { t = readTail(f, TAIL_BYTES).text; } catch (e) { return; }
    lines(t).forEach(function (l) {
      var e = ERROR_LEVELS.exec(l);
      if (e) { s.errors++; if (e[2] === 'FATAL') s.fatal++; s.lastError = l.slice(0, 500); }
      else if (WARN_LEVELS.test(l)) s.warnings++;
      if (/\sexit code \d+/.test(l)) s.exits.push(l.slice(0, 200));
      s.lastLine = l.slice(0, 300);
      var at = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s/.exec(l);
      if (at) s.lastAt = at[1];
    });
  });
  s.exits = s.exits.slice(-5);
  return s;
}

function list(root) {
  var dirs;
  try { dirs = fs.readdirSync(root).filter(function (d) { return /^oap_\d+$/.test(d); }); }
  catch (e) { throw Object.assign(new Error('OAP-Verzeichnis nicht lesbar: ' + (e.code || e.message)), { status: 503 }); }
  var procs = processes(root);
  var apps = dirs.map(function (dir) {
    var info = appInfo(root, dir), files = dataFiles(info.dataDir), log = mainLog(info, files);
    info.running = procs[dir] || [];
    info.log = summary(info.dataDir, log);
    info.files = files.map(function (f) { return { name: f.name, bytes: f.bytes, modified: f.modified, kind: f.secret ? 'secret' : f.log ? 'log' : f.report ? 'report' : 'data' }; });
    return info;
  }).sort(function (a, b) { return (b.log.errors - a.log.errors) || String(a.id || a.dir).localeCompare(String(b.id || b.dir)); });
  return { root: root, at: new Date().toISOString(), apps: apps };
}

function findApp(root, key) {
  if (typeof key !== 'string' || !key || key.length > 120 || /[\/\\]/.test(key)) throw Object.assign(new Error('app: Verzeichnisname (oap_N) oder App-ID'), { status: 400 });
  var dirs = fs.readdirSync(root).filter(function (d) { return /^oap_\d+$/.test(d); });
  if (dirs.indexOf(key) >= 0) return appInfo(root, key);
  var hit = dirs.map(function (d) { return appInfo(root, d); }).filter(function (i) { return i.id === key || i.name === key; });
  if (!hit.length) throw Object.assign(new Error('App nicht gefunden: ' + key), { status: 404 });
  return hit[0];
}

function journal(info, max) {
  var bin = ['/bin/journalctl', '/usr/bin/journalctl'].filter(function (b) { return fs.existsSync(b); })[0];
  if (!bin) return { available: false, lines: [] };
  try {
    var out = cp.execFileSync(bin, ['--no-pager', '-o', 'short-iso', '-n', '5000'], { timeout: 8000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    var keys = [info.dir + '/', info.id].filter(Boolean);
    var hits = lines(out).filter(function (l) { return keys.some(function (k) { return l.indexOf(k) >= 0; }); });
    return { available: true, lines: hits.slice(-max) };
  } catch (e) { return { available: false, error: String(e.message).slice(0, 200), lines: [] }; }
}

/** Logs and error records of one app. body: { app, lines (default 300, max 5000), journal (default true) } */
function logs(root, body) {
  var info = findApp(root, body && body.app);
  var max = Math.min(5000, Math.max(20, Number(body && body.lines) || 300));
  var files = dataFiles(info.dataDir), logName = mainLog(info, files), result = { app: info, at: new Date().toISOString(), logs: [], errors: [], reports: [], skipped: [] };
  files.filter(function (f) { return f.secret; }).forEach(function (f) { result.skipped.push({ name: f.name, reason: 'sieht nach Zugangsdaten aus' }); });
  files.filter(function (f) { return f.log && !f.secret; }).forEach(function (f) {
    var t = readTail(path.join(info.dataDir, f.name), TAIL_BYTES), all = lines(t.text);
    result.logs.push({ name: f.name, bytes: f.bytes, modified: f.modified, cut: t.cut || all.length > max, lines: all.slice(-max) });
  });
  if (logName) {
    [logName + '.1', logName].forEach(function (n) {
      try { lines(readTail(path.join(info.dataDir, n), TAIL_BYTES).text).forEach(function (l) { if (ERROR_LEVELS.test(l) || WARN_LEVELS.test(l)) result.errors.push(l.slice(0, 2000)); }); } catch (e) { /* no file */ }
    });
    result.errors = result.errors.slice(-500);
  }
  files.filter(function (f) { return f.report; }).forEach(function (f) {
    if (f.secret) return;
    if (f.bytes > 256 * 1024) { result.skipped.push({ name: f.name, reason: 'größer als 256 KiB' }); return; }
    try { result.reports.push({ name: f.name, modified: f.modified, text: fs.readFileSync(path.join(info.dataDir, f.name), 'utf8') }); } catch (e) { /* gone */ }
  });
  result.summary = summary(info.dataDir, logName);
  result.running = processes(root)[info.dir] || [];
  result.journal = body && body.journal === false ? { available: false, lines: [], skipped: true } : journal(info, 300);
  return result;
}

module.exports = { list: list, logs: logs, SECRET: SECRET };
