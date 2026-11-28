'use strict';
// Companion agent: overview and logs/error records of installed OAP apps (apps.js).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const apps = require('../native/mgu-ai-agent/apps');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oap-'));
function app(dir, id, version, files) {
  const base = path.join(root, dir);
  fs.mkdirSync(path.join(base, 'source', 'javascript'), { recursive: true });
  fs.mkdirSync(path.join(base, 'data'), { recursive: true });
  fs.writeFileSync(path.join(base, 'source', 'package.json'), JSON.stringify({ name: id, version }));
  fs.writeFileSync(path.join(base, 'source', 'javascript', 'app-spec.json'), JSON.stringify({ id, name: id + ' App', version }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(base, 'data', name), text);
}
app('oap_1', 'quiet-app', '1.0.0', { 'quiet-app.log': '2026-11-27T10:00:00.000Z INFO started\n' });
app('oap_2', 'active-sound', '2.3.1', {
  'active-sound.log.1': '2026-11-27T08:00:00.000Z WARN old warning\n',
  'active-sound.log': [
    '2026-11-27T09:00:00.000Z INFO started',
    '2026-11-27T09:01:00.000Z SDK_WARN slow bus',
    '2026-11-27T09:02:00.000Z ERROR audio sink missing',
    '2026-11-27T09:03:00.000Z FATAL uncaught TypeError: x is undefined',
    '2026-11-27T09:03:00.100Z FATAL process exit code 1'
  ].join('\n') + '\n',
  'active-sound-hu-report.json': '{"ok":false,"stage":"sink"}',
  'spotify-auth.json': '{"refresh_token":"geheim"}',
  'uplink.json': '{"key":"geheim"}',
  'settings.json': '{"volume":3}'
});
fs.mkdirSync(path.join(root, 'not-an-app'));

// A process whose command line points into oap_2 counts as running.
const child = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)', path.join(root, 'oap_2', 'source', 'main.js')], { stdio: 'ignore' });

try {
  const l = apps.list(root);
  assert.strictEqual(l.apps.length, 2, 'only oap_N directories');
  const [first, second] = l.apps;
  assert.strictEqual(first.id, 'active-sound', 'apps with errors first');
  assert.strictEqual(first.version, '2.3.1');
  assert.strictEqual(first.log.file, 'active-sound.log');
  assert.strictEqual(first.log.errors, 3);
  assert.strictEqual(first.log.fatal, 2);
  assert.strictEqual(first.log.warnings, 2);
  assert.ok(/exit code 1/.test(first.log.lastError));
  assert.strictEqual(first.log.lastAt, '2026-11-27T09:03:00.100Z');
  assert.strictEqual(first.log.exits.length, 1);
  assert.ok(first.running.some(r => r.pid === child.pid), 'running process found');
  const kinds = Object.fromEntries(first.files.map(f => [f.name, f.kind]));
  assert.strictEqual(kinds['spotify-auth.json'], 'secret');
  assert.strictEqual(kinds['uplink.json'], 'secret');
  assert.strictEqual(kinds['active-sound-hu-report.json'], 'report');
  assert.strictEqual(kinds['settings.json'], 'data');
  assert.strictEqual(second.log.errors, 0);
  assert.deepStrictEqual(second.running, []);

  for (const key of ['oap_2', 'active-sound', 'active-sound App']) {
    const d = apps.logs(root, { app: key, lines: 20, journal: false });
    assert.strictEqual(d.app.dir, 'oap_2', key);
  }
  const d = apps.logs(root, { app: 'active-sound', journal: false });
  assert.deepStrictEqual(d.logs.map(x => x.name).sort(), ['active-sound.log', 'active-sound.log.1']);
  assert.strictEqual(d.errors.length, 5, 'ERROR, FATAL and WARN lines from both log files');
  assert.ok(d.errors[0].includes('old warning'), 'rotated log comes first');
  assert.deepStrictEqual(d.reports.map(r => r.name), ['active-sound-hu-report.json']);
  assert.ok(d.reports[0].text.includes('"stage":"sink"'));
  assert.ok(!JSON.stringify(d).includes('geheim'), 'credentials never returned');
  assert.ok(d.skipped.some(s => s.name === 'spotify-auth.json'));
  assert.strictEqual(d.summary.fatal, 2);
  assert.ok(d.running.length >= 1);
  assert.strictEqual(d.journal.skipped, true);

  const cut = apps.logs(root, { app: 'oap_2', lines: 1, journal: false });
  assert.strictEqual(cut.logs.find(x => x.name === 'active-sound.log').lines.length, 5, 'at least 20 lines');

  for (const [body, status] of [[{}, 400], [{ app: '../etc' }, 400], [{ app: 'a\\b' }, 400], [{ app: 'nope' }, 404]]) {
    assert.throws(() => apps.logs(root, body), e => e.status === status, JSON.stringify(body));
  }
  assert.throws(() => apps.list(path.join(root, 'missing')), e => e.status === 503);
  console.log('agent apps: ok');
} finally {
  child.kill();
  fs.rmSync(root, { recursive: true, force: true });
}
