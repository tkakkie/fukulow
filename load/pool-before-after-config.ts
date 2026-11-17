import { plan, settings } from './pool-before-after-summary.ts';

// Round the healthy-arm startup send p99 (2.48–2.73 s at 250/s) up to
// three seconds; steady-state p95 was 16–47 ms. This is startup headroom,
// not a latency guarantee: existing caps still bound slower/saturated lanes.
export const allowanceSeconds = 3;

export function generatorConfig(smoke = false, mixed = false) {
  const steps = plan(smoke);
  const lanes = steps.flatMap(step => [
    {name:`${step.name}_send`,rate:step.rate,seconds:step.seconds,start:step.startSeconds,exec:'send'},
    ...(mixed ? [
      {name:`${step.name}_reads`,rate:settings.readRate,seconds:step.seconds,start:step.startSeconds,exec:'reads'},
      {name:`${step.name}_signin`,rate:settings.signinRate,seconds:step.seconds,start:step.startSeconds,exec:'signin'},
    ] : []),
  ]);
  const duration = steps.at(-1)!.startSeconds + steps.at(-1)!.seconds + 11;
  lanes.push({name:'reader',rate:2,seconds:duration,start:0,exec:'reader'});
  const scenarios = Object.fromEntries(lanes.map(l => {
    const cap = l.exec === 'send' ? 2000 : l.exec === 'reads' ? 1000 : 100;
    return [l.name, {executor:'constant-arrival-rate' as const,rate:l.rate,timeUnit:'1s',duration:`${l.seconds}s`,
      startTime:`${l.start}s`,exec:l.exec,preAllocatedVUs:Math.min(cap,Math.ceil(l.rate*allowanceSeconds)),maxVUs:cap,gracefulStop:'11s'}];
  }));
  return {lanes,duration,scenarios};
}
