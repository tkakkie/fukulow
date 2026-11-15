import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from './database.ts';

test('partial Docker start attempts both owned removals and preserves original failure',()=>{
  const calls:string[][]=[];const original=new Error('container created but start failed');
  const db=new Database((...args:string[])=>{
    calls.push(args);if(args[0]==='run')throw original;
    if(args[0]==='rm')throw new Error('container removal failed');return '';
  });
  assert.throws(()=>db.start(),error=>error===original);
  const old=console.error;console.error=()=>{};
  try {assert.doesNotThrow(()=>db.cleanup(original));} finally {console.error=old;}
  assert.deepEqual(calls.slice(-2),[['rm','-f',db.name],['volume','rm',db.volume]]);
});
