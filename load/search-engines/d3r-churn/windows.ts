import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { save } from '../bench.ts';
import { withSession } from '../d3r/session.ts';
import { db, full, sampleSeconds } from './design.ts';
import { interval, lsnBytes, sampleWindow, tick, type Tick, type Window } from './sampler.ts';
import { send, sendEvidence } from './send.ts';
import { lanePlacement, maintenanceSql, type Images, type Names } from './cluster.ts';
import type { Options } from './options.ts';

function recorder(dir: string, label: Window) {
  const samples: Tick[] = [];
  const intervals: ReturnType<typeof interval>[] = [];
  const record = (point: Tick) => {
    if (samples.length) intervals.push(interval(label, samples.at(-1)!.sample, point.sample));
    samples.push(point);
    save(`${dir}/${label.toLowerCase().replaceAll(' ', '-')}-samples.json`, {label, samples, intervals});
  };
  return {record, samples, intervals};
}
export type WindowEvidence = Omit<ReturnType<typeof recorder>, 'record'>;

export async function monitor(container: string, args: Options, label: Window, seconds: number,
  work: (start: number, signal: AbortSignal) => Promise<void>): Promise<WindowEvidence> {
  const {record, samples, intervals} = recorder(args.out, label);
  if (args.mode === 'smoke') {
    await work(0, new AbortController().signal);
    return {samples, intervals};
  }
  await withSession(container, db, false, async sql => {
    record(await tick(sql, 0));
    const start = performance.now();
    const stop = new AbortController();
    const tasks = [sampleWindow(seconds, start, async second => record(await tick(sql, second)), stop.signal),
      work(start, stop.signal)];
    try { await Promise.all(tasks); }
    finally {
      stop.abort();
      await Promise.allSettled(tasks);
    }
  });
  return {samples, intervals};
}

export async function sends(resources: Names, images: Images, args: Options, bodyHash: string) {
  const {record, samples, intervals} = recorder(args.out, 'W1');
  const result = await withSession(resources.client, db, false, async sql => {
    const smoke = args.mode === 'smoke';
    const stop = new AbortController();
    let start: number | undefined;
    let sampling: Promise<void> | undefined;
    let baseline: Promise<Tick> | undefined;
    let end: Promise<Tick> | undefined;
    const log = send(resources, images, args, mark => {
      if (smoke) return;
      if (mark === 'prepared') {
        baseline = tick(sql, 0).then(point => {
          save(`${args.out}/w1-k6-placement.json`, lanePlacement(resources.k6, 'client'));
          return point;
        });
        void baseline.catch(() => stop.abort());
      } else if (mark === 'started') {
        start = Date.now();
        const clock = performance.now();
        sampling = (async () => {
          assert.ok(baseline, 'W1 preparation marker is missing');
          record(await baseline);
          await sampleWindow(full.sendSeconds, clock, async second => record(await tick(sql, second)), stop.signal);
        })();
        void sampling.catch(() => stop.abort());
      } else {
        end = (async () => {
          assert.ok(sampling, 'W1 workload start marker is missing');
          await sampling;
          return tick(sql, full.sendSeconds);
        })();
        void end.catch(() => stop.abort());
      }
    }, stop.signal);
    try {
      const raw = await log;
      if (smoke) return sendEvidence(args.out, raw, bodyHash, undefined, []);
      assert.ok(baseline && sampling && end && start !== undefined, 'W1 boundaries are missing');
      const boundaries = (await Promise.all([baseline, end])).map(({startedMs, completedMs, sample}) => {
        return {startedMs, completedMs, walBytes: Number(lsnBytes(sample.lsn)), dbBytes: sample.dbBytes};
      });
      return sendEvidence(args.out, raw, bodyHash, start, boundaries);
    } finally {
      stop.abort();
      await Promise.allSettled([baseline, sampling, end]);
    }
  });
  return {result, window: {samples, intervals}};
}

export async function idle(start: number, signal: AbortSignal) {
  await delay(Math.max(1, start + full.idleSeconds * 1000 - performance.now()), undefined, {signal});
}

export async function maintenance(container: string, args: Options, label: 'W3 VACUUM' | 'W3 REINDEX', text: string) {
  const {record, samples, intervals} = recorder(args.out, label);
  return withSession(container, db, false, async sql => {
    record(await tick(sql, 0));
    const start = performance.now();
    const stop = new AbortController();
    const sampling = sampleWindow(Infinity, start, async second => record(await tick(sql, second)), stop.signal);
    const work = maintenanceSql(container, text, stop.signal);
    let finished: number;
    try {
      await Promise.race([sampling, work]);
      finished = performance.now();
    } finally {
      stop.abort();
      await Promise.allSettled([work, sampling]);
    }
    const seconds = (finished - start) / 1000;
    // A boundary passed just before the work ended can lose its timer to the abort; take it now (startedMs shows when).
    while (samples.length < 1 + Math.floor(seconds / sampleSeconds)) record(await tick(sql, samples.length * sampleSeconds));
    assert.ok(samples.length >= 1 + Math.floor(seconds / sampleSeconds), `Missing 5-minute evidence for ${label}`);
    return {samples, intervals, seconds};
  });
}
