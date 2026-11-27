'use strict';
// Companion agent side of the telemetry buffer. Compatible with Node 8.7 syntax.
// Vehicle Data writes packet files into <app data>/telemetry/. The Pi fetches them through the
// agent, stores them, and acknowledges each packet id; only then the agent deletes the file.
// A packet that was fetched but not acknowledged is sent again (the Pi deduplicates).
var fs = require('fs'), path = require('path');
var PACKET_NAME = /^p-(\d{13})-(\d{6})-([0-9a-f]{8})\.json$/;
var CONFIG_FILE = 'bmw-telemetry-config.json';
var MAX_BYTES = 1536 * 1024, MAX_PACKETS = 200;

function dirOf(appData) { return path.join(appData, 'telemetry'); }
function idOf(name) {
  var m = PACKET_NAME.exec(name);
  return m ? m[3] + '-' + Number(m[2]) + '-' + Number(m[1]) : null;
}
function names(appData) {
  var list;
  try { list = fs.readdirSync(dirOf(appData)); } catch (e) { return []; }
  return list.filter(function (n) { return PACKET_NAME.test(n); }).sort();
}
/** Oldest packets first, bounded in count and bytes. Unreadable files are reported, not sent. */
function list(appData, max) {
  var all = names(appData), out = [], bytes = 0, broken = [], limit = Math.min(Number(max) || MAX_PACKETS, MAX_PACKETS);
  for (var i = 0; i < all.length && out.length < limit; i++) {
    var file = path.join(dirOf(appData), all[i]), body;
    try { body = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    if (out.length && bytes + body.length > MAX_BYTES) break;
    var doc;
    try { doc = JSON.parse(body); } catch (e) { doc = null; }
    if (!doc || doc.schema !== 1 || doc.packetId !== idOf(all[i]) || !Array.isArray(doc.rows) || !Array.isArray(doc.events)) {
      // Packets are written atomically, so this is damage; it would block nothing but never be accepted.
      broken.push(all[i]);
      try { fs.unlinkSync(file); } catch (e) { /* already gone */ }
      continue;
    }
    bytes += body.length;
    out.push(doc);
  }
  return { schema: 1, packets: out, pending: all.length, bytes: bytes, broken: broken };
}
/** Delete acknowledged packets. Only names that match a requested id are touched. */
function ack(appData, ids) {
  if (!Array.isArray(ids) || ids.length > 500) throw new Error('ids must be a list of at most 500 packet ids');
  var wanted = {};
  ids.forEach(function (id) { if (typeof id === 'string' && /^[0-9a-f]{8}-\d{1,6}-\d{13}$/.test(id)) wanted[id] = true; });
  var deleted = 0;
  names(appData).forEach(function (n) {
    if (!wanted[idOf(n)]) return;
    try { fs.unlinkSync(path.join(dirOf(appData), n)); deleted++; } catch (e) { /* already gone */ }
  });
  return { deleted: deleted, pending: names(appData).length };
}
/** Settings for Vehicle Data, written atomically; the app reads them every 30 s. */
function writeConfig(appData, body) {
  var c = {};
  if (typeof body.enabled === 'boolean') c.enabled = body.enabled;
  if (Number.isInteger(body.idleEndMin) && body.idleEndMin >= 2 && body.idleEndMin <= 120) c.idleEndMin = body.idleEndMin;
  if (Number.isInteger(body.bufferMb) && body.bufferMb >= 2 && body.bufferMb <= 200) c.bufferMb = body.bufferMb;
  c.at = new Date().toISOString();
  var file = path.join(appData, CONFIG_FILE), tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c), { mode: 420 });
  fs.renameSync(tmp, file);
  return c;
}
module.exports = { list: list, ack: ack, writeConfig: writeConfig, idOf: idOf, PACKET_NAME: PACKET_NAME, CONFIG_FILE: CONFIG_FILE };
