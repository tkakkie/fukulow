import { f2Order } from './f2-arm.ts';
import { exceedsSendLimits, sendRatios, type PairSend } from './probe.ts';

export function f2ReferenceReport(current: PairSend[], pref2: PairSend[], f2: PairSend[]) {
  if (pref2.length !== f2Order.length) throw new Error('incomplete pre-F2 reference pairs');
  const f2VsPref2 = sendRatios(pref2, f2);
  const pref2VsCurrent = sendRatios(current, pref2);
  let f2OnlyFlag = 'no F2-only regression observed';
  if (exceedsSendLimits(f2VsPref2.medianWalPerSend, f2VsPref2.medianTps)) {
    f2OnlyFlag = 'F2-ONLY REGRESSION';
  } else if (f2VsPref2.ratios.every(r => r.walPerSend > 1) || f2VsPref2.ratios.every(r => r.tps < 1)) {
    f2OnlyFlag = 'F2-only worsening below limits';
  }
  return { f2OnlyFlag, f2VsPref2, pref2VsCurrent };
}

export function f2ReferenceMarkdown(report: ReturnType<typeof f2ReferenceReport>) {
  const ratios = (comparison: typeof report.f2VsPref2) => [
    ...comparison.ratios.map(r => `- Pair ${r.pair}: WAL/send ${r.walPerSend.toFixed(3)}, tps ${r.tps.toFixed(3)}`),
    '', `Median WAL/send ratio ${comparison.medianWalPerSend.toFixed(3)}, median tps ratio ${comparison.medianTps.toFixed(3)}`,
  ];
  return [
    '', '### F2 vs pre-F2', '', '**Report only.**', '', ...ratios(report.f2VsPref2), '', `**${report.f2OnlyFlag}**`,
    '', '### pre-F2 vs current', '', '**Report only.**', '', ...ratios(report.pref2VsCurrent),
  ];
}
