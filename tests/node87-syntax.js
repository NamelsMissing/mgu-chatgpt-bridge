'use strict';
// The MGU runs Node 8.7. New MGU-side files must not use syntax or APIs that came later.
// A light scanner: strings, template literals, comments and regex literals are blanked first.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const FILES = [
    'apps/vehicle_data/telemetry.js',
    'apps/vehicle_data/telemetry_catalog.js',
    'native/mgu-ai-agent/agent.js',
    'native/mgu-ai-agent/telemetry-outbox.js',
    'native/mgu-ai-agent/shell.js',
    'native/mgu-ai-agent/apps.js',
];
const RULES = [
    [/\?\.(?!\d)/, 'optional chaining (Node 14)'],
    [/\?\?/, 'nullish coalescing (Node 14)'],
    [/\bcatch\s*\{/, 'optional catch binding (Node 10)'],
    [/\{\s*\.\.\./, 'object spread (unreliable before Node 8.3)'],
    [/\.(?:flat|flatMap|matchAll|trimStart|trimEnd|at|replaceAll)\(/, 'API newer than Node 8'],
    [/\bObject\.(?:fromEntries|hasOwn)\b/, 'API newer than Node 8'],
    [/\bglobalThis\b|\bstructuredClone\b|\bAbortSignal\b|\bfetch\(/, 'API newer than Node 8'],
    [/\bfs\.promises\b|require\('node:/, 'API newer than Node 8'],
    [/^\s*(?:static\s+)?#?[A-Za-z_$][\w$]*\s*=\s*[^=]/m, null],     // class fields are checked below
];
function blank(src) {
    let out = '', i = 0, prev = '';
    while (i < src.length) {
        const c = src[i], n = src[i + 1];
        if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
        if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; out += src.slice(i, end).replace(/[^\n]/g, ' '); i = end; continue; }
        if (c === '"' || c === "'" || c === '`') {
            let j = i + 1;
            while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
            out += c + ' '.repeat(Math.max(0, j - i - 1)) + c; i = j + 1; prev = c; continue;
        }
        if (c === '/' && (prev === '' || /[(,=:[!&|?{};]$/.test(prev))) {
            let j = i + 1, cls = false;
            while (j < src.length && (src[j] !== '/' || cls)) { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; }
            out += '/' + ' '.repeat(Math.max(0, j - i - 1)) + '/'; i = j + 1; prev = '/'; continue;
        }
        out += c;
        if (!/\s/.test(c)) prev = c;
        i++;
    }
    return out;
}
let checked = 0;
for (const file of FILES) {
    const code = blank(fs.readFileSync(path.join(root, file), 'utf8'));
    for (const [re, what] of RULES) {
        if (!what) continue;
        const m = re.exec(code);
        assert.ok(!m, file + ': ' + what + ' near "' + (m && code.slice(Math.max(0, m.index - 30), m.index + 30).replace(/\s+/g, ' ')) + '"');
    }
    assert.ok(!/class\s+\w+[^{]*\{[^}]*^\s+#?\w+\s*=/m.test(code), file + ': class fields (Node 12)');
    checked++;
}
// The scanner itself must catch what it is meant to catch.
assert.ok(/\?\.(?!\d)/.test(blank('a?.b')) && !/\?\.(?!\d)/.test(blank("x ? .5 : 'a?.b'")));
assert.ok(/\?\?/.test(blank('a ?? b')) && !/\?\?/.test(blank('/a??/.test(x)')));
console.log('Node 8.7 syntax: ' + checked + ' MGU files passed.');
