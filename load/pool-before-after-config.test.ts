import test from 'node:test';
import assert from 'node:assert/strict';
import { allowanceSeconds, generatorConfig } from './pool-before-after-config.ts';

test('no scenario preallocates fewer VUs than origin/main', () => {
  // Verified from origin/main:load/pool-before-after-load.ts for PR #570.
  const previous = {send:100,reads:50,signin:10,reader:10};
  for (const smoke of [false,true]) for (const mixed of [false,true]) {
    const {lanes,scenarios} = generatorConfig(smoke,mixed);
    for (const lane of lanes) {
      assert.ok(scenarios[lane.name].preAllocatedVUs >= previous[lane.exec as keyof typeof previous],
        `${lane.name} (smoke=${smoke}, mixed=${mixed}) must retain its previous VU floor`);
    }
  }
});

test('every rate preallocates the startup allowance subject to unchanged caps', () => {
  assert.equal(allowanceSeconds,3);
  for (const smoke of [false,true]) for (const mixed of [false,true]) {
    const {lanes,scenarios} = generatorConfig(smoke,mixed);
    for (const lane of lanes) {
      const config = scenarios[lane.name];
      const cap = lane.exec === 'send' ? 2000 : lane.exec === 'reads' ? 1000 : 100;
      const previous = lane.exec === 'send' ? 100 : lane.exec === 'reads' ? 50 : 10;
      assert.equal(config.preAllocatedVUs,Math.min(cap,Math.max(previous,Math.ceil(lane.rate*allowanceSeconds))));
      assert.equal(config.maxVUs,cap);
      assert.ok(config.preAllocatedVUs <= cap);
      // A three-second allowance cannot fit at every rate under the old caps.
      // Where capped, assert the effective allowance instead of claiming 3 s.
      assert.ok(config.preAllocatedVUs >= lane.rate*Math.min(allowanceSeconds,cap/lane.rate));
    }
  }
  // The diagnostic first-step send p99 was 2.48–2.73 s. Even three
  // seconds of concurrent arrivals must fit without allocating another VU.
  assert.ok(generatorConfig(false,true).scenarios.step_1_send.preAllocatedVUs >= 250*3);
  assert.deepEqual([250,500,1000,2000].map((_,i)=>generatorConfig(false,true).scenarios[`step_${i+1}_send`].preAllocatedVUs),
    [750,1500,2000,2000]);
});

type Scenarios = ReturnType<typeof generatorConfig>['scenarios'];

// Compute the planned peak over duration + gracefulStop, processing equal-time
// events in scenario order (startTime, then name). This does not assert when
// k6 actually initializes or releases VUs at a step boundary.
function peakPlannedVUs(scenarios:Scenarios) {
  const ordered = Object.entries(scenarios).sort(([an,a],[bn,b])=>
    parseFloat(a.startTime)-parseFloat(b.startTime) || an.localeCompare(bn));
  const events = ordered.flatMap(([,s],order)=>[
    {time:parseFloat(s.startTime),delta:s.preAllocatedVUs,order},
    {time:parseFloat(s.startTime)+parseFloat(s.duration)+parseFloat(s.gracefulStop),delta:-s.preAllocatedVUs,order},
  ]).sort((a,b)=>a.time-b.time || a.order-b.order);
  let current=0,peak=0;
  for (const event of events) { current+=event.delta;peak=Math.max(peak,current); }
  assert.equal(current,0);
  return peak;
}

test('peak initialized VUs are bounded for smoke/formal send/mixed execution plans', () => {
  for (const smoke of [true,false]) for (const mixed of [false,true]) {
    const {scenarios} = generatorConfig(smoke,mixed);
    const fullCaps = Object.fromEntries(Object.entries(scenarios).map(([name,s])=>[name,{...s,preAllocatedVUs:s.maxVUs}]));
    const original = Object.fromEntries(Object.entries(scenarios).map(([name,s])=>[name,{...s,
      preAllocatedVUs:s.exec==='send'?100:s.exec==='reads'?50:10}]));
    assert.equal(peakPlannedVUs(original),mixed ? 100+50+10+10 : 100+10);
    assert.equal(peakPlannedVUs(fullCaps),mixed ? 2000+1000+100+100 : 2000+100);
    assert.equal(peakPlannedVUs(scenarios),smoke ? (mixed ? 150+1000+60+10 : 150+10) :
      (mixed ? 2000+1000+60+10 : 2000+10));
  }
});

test('peak calculation includes graceful-stop overlaps rather than only active arrivals', () => {
  const {scenarios} = generatorConfig(false,false);
  // Moving step 2 one second earlier creates a real overlap with step 1's drain.
  scenarios.step_2_send.startTime='70s';
  assert.equal(peakPlannedVUs(scenarios),750+1500+10);
});

test('measured schedules, drains, rates and executors remain unchanged with no warm-up', () => {
  for (const smoke of [false,true]) for (const mixed of [false,true]) {
    const {lanes,duration,scenarios} = generatorConfig(smoke,mixed);
    const rates = smoke ? [50] : [250,500,1000,2000];
    const seconds = smoke ? 10 : 60;
    const expected = rates.flatMap((rate,index) => {
      const start = index*71;
      const name = `step_${index+1}`;
      return [
        {name:`${name}_send`,rate,seconds,start,exec:'send'},
        ...(mixed ? [
          {name:`${name}_reads`,rate:500,seconds,start,exec:'reads'},
          {name:`${name}_signin`,rate:20,seconds,start,exec:'signin'},
        ] : []),
      ];
    });
    assert.equal(duration,smoke ? 21 : 284);
    expected.push({name:'reader',rate:2,seconds:duration,start:0,exec:'reader'});
    assert.deepEqual(lanes,expected);
    assert.equal(Object.keys(scenarios).length,expected.length);
    for (const lane of expected) {
      const {preAllocatedVUs,maxVUs,...config} = scenarios[lane.name];
      assert.deepEqual(config,{executor:'constant-arrival-rate',rate:lane.rate,timeUnit:'1s',
        duration:`${lane.seconds}s`,startTime:`${lane.start}s`,exec:lane.exec,gracefulStop:'11s'});
    }
  }
});
