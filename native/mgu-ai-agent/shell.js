'use strict';
// Full shell on the MGU, like an SSH session: /bin/sh -c COMMAND as the agent user (root).
// Pipes, redirects, loops and writes are allowed. The Pi only sends commands that the owner
// typed in the web console or approved under "Freigaben" (or by the owner's auto-approval).
// Compatible with Node 8.7 syntax.
var cp = require('child_process');
var fs = require('fs');

var MAX_OUTPUT = 1024 * 1024;           // per stream
var MAX_COMMAND = 16000;
var DEFAULT_TIMEOUT = 60, MAX_TIMEOUT = 900;

function shellBinary() {
  var list = ['/bin/sh', '/usr/bin/sh', '/bin/bash'];
  for (var i = 0; i < list.length; i++) if (fs.existsSync(list[i])) return list[i];
  return '/bin/sh';
}

/** Run one command. cb(err, result). result: stdout, stderr, exitCode, signal, timedOut, truncated, durationMs. */
function run(body, cb) {
  var command = body && body.command;
  if (typeof command !== 'string' || !command.trim()) return cb(Object.assign(new Error('command required'), { status: 400 }));
  if (command.length > MAX_COMMAND) return cb(Object.assign(new Error('command longer than ' + MAX_COMMAND + ' characters'), { status: 400 }));
  var timeout = Number(body.timeoutSec);
  if (!isFinite(timeout) || timeout <= 0) timeout = DEFAULT_TIMEOUT;
  timeout = Math.min(MAX_TIMEOUT, Math.max(1, Math.round(timeout)));
  var cwd = typeof body.cwd === 'string' && body.cwd[0] === '/' && fs.existsSync(body.cwd) ? body.cwd : '/';
  var env = Object.assign({}, process.env, { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', TERM: 'dumb', HOME: process.env.HOME || '/root' });
  var started = Date.now(), out = [], err = [], outBytes = 0, errBytes = 0, truncated = false, timedOut = false, done = false;
  var child;
  try {
    // detached: own process group, so a timeout also ends everything the command started.
    child = cp.spawn(shellBinary(), ['-c', command], { cwd: cwd, env: env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { return cb(Object.assign(new Error('spawn failed: ' + e.message), { status: 500 })); }
  function kill(sig) {
    try { process.kill(-child.pid, sig); } catch (e) { try { child.kill(sig); } catch (ignored) { /* gone */ } }
  }
  var timer = setTimeout(function () { timedOut = true; kill('SIGTERM'); setTimeout(function () { kill('SIGKILL'); }, 3000); }, timeout * 1000);
  function collect(list, chunk, which) {
    var used = which === 'out' ? outBytes : errBytes;
    if (used >= MAX_OUTPUT) { truncated = true; return; }
    var part = chunk.length + used > MAX_OUTPUT ? chunk.slice(0, MAX_OUTPUT - used) : chunk;
    if (part.length < chunk.length) truncated = true;
    list.push(part);
    if (which === 'out') outBytes += part.length; else errBytes += part.length;
  }
  child.stdout.on('data', function (c) { collect(out, c, 'out'); });
  child.stderr.on('data', function (c) { collect(err, c, 'err'); });
  child.on('error', function (e) {
    if (done) return;
    done = true; clearTimeout(timer);
    cb(Object.assign(new Error('shell failed: ' + e.message), { status: 500 }));
  });
  child.on('close', function (code, signal) {
    if (done) return;
    done = true; clearTimeout(timer);
    cb(null, {
      command: command, shell: true, cwd: cwd,
      stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'),
      exitCode: code === null ? null : code, signal: signal || null, timedOut: timedOut, truncated: truncated,
      durationMs: Date.now() - started, at: new Date(started).toISOString()
    });
  });
}

module.exports = { run: run, MAX_OUTPUT: MAX_OUTPUT, MAX_COMMAND: MAX_COMMAND, MAX_TIMEOUT: MAX_TIMEOUT };
