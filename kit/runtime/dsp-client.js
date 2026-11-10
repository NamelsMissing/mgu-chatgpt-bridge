'use strict';
const net = require('net');
const path = require('path');
const { Transform } = require('stream');
const RUNTIME = '/run/mgu-equalizer-dsp';
function defaults() { return { enabled: false, preampDb: 0, autoHeadroom: true,
    bands: [100, 200, 500, 1000, 2000, 5000, 10000].map((frequencyHz) => ({ frequencyHz, gainDb: 0, q: 1 })) }; }
function request(op, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
        const socket = net.connect(path.join(opts.runtime || RUNTIME, 'control.sock')); let buf = '', done = false;
        const finish = (e, result) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); e ? reject(e) : resolve(result); };
        const timer = setTimeout(() => finish(new Error('DSP-Dienst antwortet nicht')), opts.timeout || 2000);
        socket.on('connect', () => socket.write(JSON.stringify(op) + '\n'));
        socket.on('error', (e) => finish(e)); socket.on('end', () => { if (!done) finish(new Error('DSP-Verbindung vorzeitig beendet')); });
        socket.on('data', (chunk) => {
            buf += chunk.toString('utf8'); if (buf.length > 65536) return finish(new Error('DSP-Antwort zu groß'));
            const nl = buf.indexOf('\n'); if (nl < 0) return;
            try { const r = JSON.parse(buf.slice(0, nl)); if (!r.ok) throw new Error(r.error || 'DSP-Fehler'); finish(null, r.data); } catch (e) { finish(e); }
        });
    });
}
class PcmFilter extends Transform {
    constructor(opts) {
        super({ highWaterMark: 16384 }); this.opts = opts || {}; this.frameBytes = 2 * (this.opts.channels || 2);
        this.socket = null; this.ready = false; this.failed = false; this.input = Buffer.alloc(0); this.rx = Buffer.alloc(0);
        this.pending = null; this.timer = null; this.closing = false; this.fallback = this.opts.onFallback || (() => {});
        this.on('error', () => this.close());
    }
    close() { this.closing = true; clearTimeout(this.timer); this.timer = null; if (this.socket) this.socket.destroy(); this.socket = null; }
    fail(error) {
        if (this.failed || this.destroyed) return;
        this.failed = true; this.close(); this.rx = Buffer.alloc(0);
        this.fallback(String(error && error.message || error));
        if (this.pending) { const p = this.pending; this.pending = null; this.push(p.raw); p.cb(); }
    }
    connect() {
        const socket = this.socket = net.connect(path.join(this.opts.runtime || RUNTIME, 'pcm.sock'));
        socket.on('connect', () => socket.write(JSON.stringify({ protocol: 1, format: 's16le', sampleRate: this.opts.sampleRate || 44100,
            channels: this.opts.channels || 2, source: this.opts.source || 'custom-app' }) + '\n'));
        socket.on('error', (e) => this.fail(e)); socket.on('close', () => { if (!this.closing && !this.failed && !this.destroyed) this.fail(new Error('DSP-Stream getrennt')); });
        socket.on('data', (chunk) => {
            if (this.failed || this.destroyed) return;
            if (!this.ready) {
                this.rx = this.rx.length ? Buffer.concat([this.rx, chunk]) : chunk;
                const nl = this.rx.indexOf(10); if (nl < 0) { if (this.rx.length > 1024) this.fail(new Error('DSP-Handshake zu groß')); return; }
                try { const h = JSON.parse(this.rx.slice(0, nl).toString('utf8')); if (!h.ok || h.protocol !== 1) throw new Error('DSP-Protokoll abgewiesen'); }
                catch (e) { this.fail(e); return; }
                this.rx = this.rx.slice(nl + 1); this.ready = true; this.send();
            } else this.rx = this.rx.length ? Buffer.concat([this.rx, chunk]) : chunk;
            if (this.rx.length < 4) return;
            const len = this.rx.readUInt32LE(0);
            if (!this.pending || len !== this.pending.raw.length || len > 16384) return this.fail(new Error('DSP-Blockgröße stimmt nicht'));
            if (this.rx.length < len + 4) return;
            if (this.rx.length !== len + 4) return this.fail(new Error('Unerwartete DSP-Zusatzdaten'));
            const out = this.rx.slice(4), p = this.pending; this.pending = null; this.rx = Buffer.alloc(0); clearTimeout(this.timer);
            this.push(out); p.cb();
        });
    }
    send() {
        if (!this.ready || !this.pending || this.pending.sent || this.failed) return;
        this.pending.sent = true; const h = Buffer.allocUnsafe(4); h.writeUInt32LE(this.pending.raw.length, 0);
        this.socket.write(Buffer.concat([h, this.pending.raw]));
    }
    block(raw, cb) {
        if (this.failed) { this.push(raw); return cb(); }
        this.pending = { raw, cb, sent: false };
        this.timer = setTimeout(() => this.fail(new Error('DSP-Block-Zeitüberschreitung')), this.opts.timeout || 600);
        if (!this.socket) this.connect(); else this.send();
    }
    _transform(chunk, encoding, callback) {
        const b = this.input.length ? Buffer.concat([this.input, chunk]) : chunk;
        const whole = b.length - b.length % this.frameBytes;
        this.input = b.slice(whole);
        let offset = 0;
        const next = () => {
            if (offset >= whole) return callback();
            const end = Math.min(whole, offset + 16384 - 16384 % this.frameBytes), raw = b.slice(offset, end); offset = end;
            this.block(raw, next);
        };
        next();
    }
    _flush(callback) {
        // Preserve even a truncated upstream tail; never invent or duplicate audio bytes.
        if (this.input.length) this.push(this.input);
        this.input = Buffer.alloc(0); this.close(); callback();
    }
    _destroy(error, callback) { this.close(); this.pending = null; callback(error); }
}
module.exports = { defaults, request, PcmFilter, RUNTIME };

