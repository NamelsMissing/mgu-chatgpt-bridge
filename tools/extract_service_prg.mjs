// Append a bounded maintenance-table projection from local PRGs to a generated seed.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [parser, directory, output] = process.argv.slice(2);
if (!parser || !directory || !output) throw Error('Usage: node extract_service_prg.mjs <MotorScope/prg-tables.mjs> <PRG directory> <seed.json>');
const { readPrg } = await import(pathToFileURL(resolve(parser)).href);
const seed = JSON.parse(readFileSync(output, 'utf8'));
seed.rows = seed.rows.filter(row => !row.namespace.startsWith('uds.kombi.cbs'));
const variants = { KOMBSP18: 'CBSNRTEXT', KOMBSP21: 'CBS_7_0_KENNUNG', KOMB_G11: 'CBSKENNUNG' };
for (const [variant, mapping] of Object.entries(variants)) {
  const source = variant + '.prg';
  const tables = readPrg(readFileSync(join(directory, source))).tables;
  for (const [table, { columns, rows }] of Object.entries(tables)) {
    const scope = table === mapping;
    if (!scope && (!/^(TAB_CBS_|CBS_STATUS_|CBS_7_0_LESEN_|CBS_EINHEITS)/.test(table) || String(columns) !== 'WERT,TEXT')) continue;
    for (const [id, symbol, label] of rows) {
      const code = Number(id), raw = scope ? label : symbol;
      if (!/^0x[0-9a-f]+$/i.test(id) || !raw || code > 65535) continue;
      const statusLabel = raw.replace(/[\x00-\x1f]/g, ' ').trim();
      const de = scope ? raw : statusLabel.length > 180 ? '' : statusLabel;
      const verification = (scope ? code >= 0xE0 : /reserviert|unbelegt|ungueltig|ungültig/i.test(raw)) ? 'reserved' : 'verified';
      const row = {namespace: scope ? 'uds.kombi.cbs' : 'uds.kombi.cbs.' + table, code, original: scope ? symbol : id};
      if (!scope) row.table = table;
      row.de = de;
      if (!scope) row.description = statusLabel.length > 180 ? statusLabel.slice(0, 500) : '';
      row.category = scope ? 'wartungsumfang' : /EINHEIT/.test(table) ? 'einheit' : 'status';
      Object.assign(row, {interface: table, source, variant, version: 'PRG-Lieferstand', verification});
      seed.rows.push(row);
    }
  }
}
const rows = seed.rows.map(row => JSON.stringify(row));
writeFileSync(output, JSON.stringify({schema: 1, version: seed.version}).slice(0, -1) + ',"rows":[\n' + rows.join(',\n') + '\n]}\n');
