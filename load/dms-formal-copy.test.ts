import { test } from 'node:test';
import assert from 'node:assert/strict';

test('restore failure after daemon creation stops, awaits and removes its own copy',async()=>{
  const {copyVolume}=await import('./dms-formal-copy.ts');const events:string[][]=[];
  await assert.rejects(copyVolume(async command=>{
    events.push(command.args);
    if(command.args[0]==='run')throw new Error('failed after creation');
    return {code:0,stdout:command.args[0]==='ps'?'copy-id':''};
  },'dm-formal-test',2,'snapshot','data','pinned',true),/after creation/);
  assert.deepEqual(events.slice(1).map(args=>args[0]),['ps','stop','wait','rm']);
  assert.ok(events.slice(2).every(args=>args.includes('dm-formal-test-copy-2')));
});
