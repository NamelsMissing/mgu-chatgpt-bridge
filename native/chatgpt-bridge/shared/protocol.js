'use strict';
var crypto = require('crypto');
var CATALOG = {
    system: { title: 'System version and uptime', commands: [['uname', ['-a']], ['uptime', []]] },
    processes: { title: 'Running processes', commands: [['ps', []]] },
    network: { title: 'Network routes and addresses', commands: [['ip', ['-4', 'addr']], ['ip', ['-4', 'route']]] },
    audio: { title: 'ALSA playback devices', commands: [['aplay', ['-l']], ['aplay', ['-L']]] },
    services: { title: 'Failed system services', commands: [['systemctl', ['--failed', '--no-pager', '--plain']]] }
};
function canonical(x) {
    if (x === null || typeof x !== 'object') return JSON.stringify(x);
    if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']';
    return '{' + Object.keys(x).sort().map(function(k) { return JSON.stringify(k) + ':' + canonical(x[k]); }).join(',') + '}';
}
function hash(x) { return crypto.createHash('sha256').update(canonical(x)).digest('hex'); }
function sign(x, key) { return crypto.createHmac('sha256', key).update(canonical(x)).digest('hex'); }
function equal(a,b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    var aa=Buffer.from(a), bb=Buffer.from(b);
    return aa.length === bb.length && crypto.timingSafeEqual(aa,bb);
}
function validate(op) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) throw Error('Invalid operation');
    var keys;
    if (op.type === 'catalog') {
        keys=['type','name'];
        if (!Object.prototype.hasOwnProperty.call(CATALOG,op.name)) throw Error('Unknown diagnostic');
    } else if (op.type === 'file') {
        keys=['type','path','offset','length'];
        if (typeof op.path !== 'string' || op.path.length > 512 || op.path[0] !== '/' || /[\x00-\x1f]/.test(op.path)) throw Error('Invalid file path');
        if (!Number.isSafeInteger(op.offset) || op.offset < 0 || op.offset > 1073741824) throw Error('Invalid offset');
        if (!Number.isSafeInteger(op.length) || op.length < 1 || op.length > 131072) throw Error('File chunk must be 1..131072 bytes');
    } else if (op.type === 'shell') {
        keys=['type','command'];
        if (typeof op.command !== 'string' || !op.command.trim() || op.command.length > 4096 || op.command.indexOf('\0') !== -1) throw Error('Invalid shell command');
    } else throw Error('Unknown operation');
    if (Object.keys(op).some(function(k){return keys.indexOf(k)<0;})) throw Error('Unexpected operation field');
    return op;
}
module.exports={CATALOG:CATALOG,canonical:canonical,hash:hash,sign:sign,equal:equal,validate:validate};
