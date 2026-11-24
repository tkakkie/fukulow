import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { hostRecord, linuxViolations } from './harness-core/host-record.ts';

// Writes the host record (#796 item 2) for a run directory. With --check, exits 3 when a Linux
// measurement condition (#796 item 3) is not met, so a waiter can STOP before it starts a run.
const usage = 'node load/host-record.ts --out FILE [--disk PATH] [--check]';
const { values } = parseArgs({ options: { out: { type: 'string' }, disk: { type: 'string' }, check: { type: 'boolean' }, help: { type: 'boolean' } } });
if (values.help) { console.log(usage); process.exit(0); }
if (!values.out) throw new Error(usage);
const record = hostRecord(values.disk ?? process.cwd());
const violations = linuxViolations(record);
writeFileSync(values.out, JSON.stringify({ ...record, violations }, null, 2) + '\n', { flag: 'wx' });
for (const v of violations) console.error(`STOP: ${v}`);
if (values.check && violations.length > 0) process.exit(3);
