import { plan, settings } from './pool-before-after-summary.ts';

// Round the healthy-arm startup send p99 (2.48–2.73 s at 250/s) up to
// three seconds; steady-state p95 was 16–47 ms. This is startup headroom,
// not a latency guarantee: existing caps still bound slower/saturated lanes.
export const allowanceSeconds = 3;

// Retain the full four-step mixed arm, including fixture setup and drains.
const diagnosticLogLimitMiB = 512;
export const diagnosticComposeOverride = {
  services: { app: {
    environment: { FUKULOW_CLIENT_IP_HEADER: 'x-load-client-ip', FUKULOW_TRUSTED_PROXIES: '0.0.0.0/0,::/0' },
    logging: { options: { 'max-size': `${diagnosticLogLimitMiB}m` } },
  } },
};
export const diagnosticLogBufferBytes = diagnosticLogLimitMiB * 1024 * 1024;

export function generatorVersion(value = 'new', name = 'generator'): 'old' | 'new' {
  if (value !== 'old' && value !== 'new') throw new Error(`${name} must be old or new`);
  return value;
}

export function diagnosticRates(value?: string) {
  if (value === undefined) return settings.rates;
  const requested = value.split(',').map(rate => rate.trim());
  const rates = settings.rates.filter(rate => requested.includes(String(rate)));
  if (rates.length !== requested.length) throw new Error(`DIAG_RATES must list distinct rates from ${settings.rates.join(',')}`);
  return rates;
}

export function diagnosticConfig(env: Record<string, string | undefined>) {
  return { generators: { B: generatorVersion(env.DIAG_GEN_B, 'DIAG_GEN_B'), A: generatorVersion(env.DIAG_GEN_A, 'DIAG_GEN_A') },
    rates: diagnosticRates(env.DIAG_RATES ?? String(settings.rates[0])) };
}

export function generatorConfig(smoke = false, mixed = false, version = generatorVersion(), rates = settings.rates) {
  const steps = plan(smoke, mixed ? rates : settings.rates);
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
    const previous = l.exec === 'send' ? 100 : l.exec === 'reads' ? 50 : 10;
    return [l.name, {executor:'constant-arrival-rate' as const,rate:l.rate,timeUnit:'1s',duration:`${l.seconds}s`,
      startTime:`${l.start}s`,exec:l.exec,preAllocatedVUs:version === 'old' ? previous : Math.min(cap,Math.max(previous,Math.ceil(l.rate*allowanceSeconds))),maxVUs:cap,gracefulStop:'11s'}];
  }));
  return {steps,lanes,duration,scenarios};
}
