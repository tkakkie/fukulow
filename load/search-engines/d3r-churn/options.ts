import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { outsideCheckout } from '../../proxy-target.ts';
import { full, stages, type Stage } from './design.ts';

export function options(args: string[]) {
  const {values} = parseArgs({args, options: {
    smoke: {type: 'boolean'}, rehearsal: {type: 'boolean'}, formal: {type: 'boolean'},
    out: {type: 'string'}, messages: {type: 'string'}, 'app-image': {type: 'string'},
    'from-backfill': {type: 'string'}, 'preserve-backfill': {type: 'boolean'},
  }});
  const modes = (Object.keys(stages) as Stage[]).filter(mode => values[mode]);
  assert.equal(modes.length, 1, 'Use exactly one of --smoke, --rehearsal or --formal');
  const [mode] = modes;
  assert.ok(values.out && values['app-image'], 'Use --out=<new-external-directory> and --app-image=<local-image-ID>');
  const rows = values.messages === undefined ? mode === 'smoke' ? 1000 : full.rows : Number(values.messages);
  assert.ok(values.messages === undefined || (mode === 'smoke' && /^\d+$/.test(values.messages) &&
    Number.isSafeInteger(rows) && rows >= 20 && rows <= 10_000), '--messages is for smoke only (20–10,000)');
  assert.ok(!(values['preserve-backfill'] && values['from-backfill']), 'Choose either --preserve-backfill or --from-backfill');
  assert.ok(mode === 'smoke' || /^sha256:[0-9a-f]{64}$/.test(values['app-image']), 'Full-size stages require an immutable app image ID');
  return {mode, rows, out: outsideCheckout(values.out), appImage: values['app-image'],
    preserve: values['preserve-backfill'] === true, from: values['from-backfill']};
}
export type Options = ReturnType<typeof options>;
